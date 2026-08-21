import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { provision, testPool, type Provisioned } from "./helpers/db";
import {
  createAppSchema,
  applyConfig,
  createPools,
  makeBroker,
  SEED_REV_COLUMNS,
  SEED_REV_VALUES,
} from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";
import type { Pools } from "../src/db/pools";
import type { BrokerResult } from "../src/types";

// Batched multi-query read (Phase 3, P1-1): `queryBatch`, up to MAX_BATCH_QUERIES labelled
// QueryIntents run sequentially and returned in one envelope. Model is broker-query.test.ts and
// keyset-pagination.test.ts; this file is about the BATCH shape and — the main correctness risk —
// that one sub-query's grant, filters and masks never leak into another's.

let p: Provisioned, admin: Pool, pools: Pools, broker: ReturnType<typeof makeBroker>;

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  collections: {
    items: {
      description: "Items",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        seq: { type: "int", posture: "allow" },
        val: { type: "text", posture: "allow" },
      },
    },
    filtered: {
      description: "Document-filtered",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        dept: { type: "text", posture: "allow" },
        val: { type: "text", posture: "allow" },
      },
    },
    narrow: {
      description: "Narrow allowedFields",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        a: { type: "text", posture: "allow" },
        b: { type: "text", posture: "allow" },
      },
    },
    masked: {
      description: "Masked field",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        secret: {
          type: "text",
          posture: { read: "mask", write: "deny" },
          mask: { transform: "redact" },
        },
      },
    },
    aclcol: {
      description: "ACL'd",
      acl: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        title: { type: "text", posture: "allow" },
      },
    },
    nogrant: {
      description: "No grant held here",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        val: { type: "text", posture: "allow" },
      },
    },
  },
});

const ID = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`.slice(0, 36);

async function grantOn(
  userId: string,
  collection: string,
  fields: string[],
  opts: { documentFilters?: { field: string; op: string; value: unknown }[] } = {},
) {
  const id = await requestGrant(admin, {
    userId,
    collection,
    env: "dev",
    workspaceId: "default",
    purposeLabel: "test",
    allowedFields: fields,
  });
  const r = await approveGrant(admin, cfg, id, "admin", {
    verbs: ["read"],
    ...(opts.documentFilters ? { documentFilters: opts.documentFilters as never } : {}),
  });
  expect(r.ok, JSON.stringify(r)).toBe(true);
}

// isouser: the caller for the isolation matrix — holds grants on every collection but `nogrant`.
const ISO = "isouser";
let aclPublicId: string;
let aclRestrictedId: string;

beforeAll(async () => {
  p = await provision("query-batch");
  admin = testPool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);

  // items: parity (test 1) and keyset (test 7) — 5 rows, seq 0..4.
  for (let i = 0; i < 5; i++) {
    await admin.query(
      `insert into data_synth.items (${SEED_REV_COLUMNS}, id, seq, val) values (${SEED_REV_VALUES}, $1, $2, $3)`,
      [ID(9000 + i), i, `v${i}`],
    );
  }
  await grantOn("parityuser", "items", ["id", "seq", "val"]);
  await grantOn("walker", "items", ["id", "seq", "val"]);
  await grantOn("nogranthaver", "narrow", ["id"]); // used by test 2 (a collection this caller CAN read)

  // filtered: 2 Engineering, 1 Sales — grant admits Engineering only.
  await admin.query(
    `insert into data_synth.filtered (${SEED_REV_COLUMNS}, id, dept, val) values
       (${SEED_REV_VALUES}, $1, 'Engineering', 'e1'),
       (${SEED_REV_VALUES}, $2, 'Engineering', 'e2'),
       (${SEED_REV_VALUES}, $3, 'Sales', 's1')`,
    [ID(1001), ID(1002), ID(1003)],
  );
  await grantOn(ISO, "filtered", ["id", "dept", "val"], {
    documentFilters: [{ field: "dept", op: "eq", value: "Engineering" }],
  });

  // narrow: grant carries only id+a, never b.
  await admin.query(
    `insert into data_synth.narrow (${SEED_REV_COLUMNS}, id, a, b) values
       (${SEED_REV_VALUES}, $1, 'a1', 'b1'),
       (${SEED_REV_VALUES}, $2, 'a2', 'b2')`,
    [ID(2001), ID(2002)],
  );
  await grantOn(ISO, "narrow", ["id", "a"]);

  // masked: secret comes back redacted.
  await admin.query(
    `insert into data_synth.masked (${SEED_REV_COLUMNS}, id, secret) values
       (${SEED_REV_VALUES}, $1, 'raw-secret-1'),
       (${SEED_REV_VALUES}, $2, 'raw-secret-2')`,
    [ID(3001), ID(3002)],
  );
  await grantOn(ISO, "masked", ["id", "secret"]);

  // aclcol: one public, one restricted to a principal ISO does not hold.
  aclPublicId = ID(4001);
  aclRestrictedId = ID(4002);
  await admin.query(
    `insert into data_synth.aclcol (${SEED_REV_COLUMNS}, id, title) values
       (${SEED_REV_VALUES}, $1, 'public'),
       (${SEED_REV_VALUES}, $2, 'restricted')`,
    [aclPublicId, aclRestrictedId],
  );
  await admin.query(
    `insert into data_synth."_acl" (workspace_id, collection, document_id, principals, updated_by)
     values ('default','aclcol',$1, array['user:someone-else'],'test')`,
    [aclRestrictedId],
  );
  await grantOn(ISO, "aclcol", ["id", "title"]);

  // nogrant: seeded, but ISO never gets a grant on it.
  await admin.query(
    `insert into data_synth.nogrant (${SEED_REV_COLUMNS}, id, val) values (${SEED_REV_VALUES}, $1, 'x')`,
    [ID(5001)],
  );
}, 120_000);

afterAll(async () => {
  await admin.end();
  await pools.end();
  await p.end();
});

async function auditRows(ids: (string | null)[]) {
  const real = ids.filter((x): x is string => x !== null);
  if (real.length === 0) return [];
  const r = await admin.query(
    `select id, collection, outcome, reason from app.audit_events where id = any($1)`,
    [real],
  );
  return r.rows as {
    id: string;
    collection: string | null;
    outcome: string;
    reason: string | null;
  }[];
}

describe("queryBatch: parity with individual query() calls", () => {
  it("a batch of 3 returns results identical to 3 individual calls, field for field", async () => {
    const ctx = makeCtx({ userId: "parityuser" });
    const individual: BrokerResult[] = [];
    for (const filter of [0, 1, 2]) {
      individual.push(
        await broker.query(ctx, {
          collection: "items",
          fields: ["id", "seq", "val"],
          filters: [{ field: "seq", op: "eq", value: filter }],
        }),
      );
    }

    const batch = await broker.queryBatch(ctx, {
      queries: [0, 1, 2].map((n) => ({
        label: `q${n}`,
        collection: "items",
        fields: ["id", "seq", "val"],
        filters: [{ field: "seq", op: "eq", value: n }],
      })),
    });
    expect(batch.ok, JSON.stringify(batch)).toBe(true);
    if (!batch.ok) return;

    for (const n of [0, 1, 2]) {
      const solo = individual[n]!;
      const viaBatch = batch.results[`q${n}`]!;
      expect(solo.ok).toBe(true);
      expect(viaBatch.ok).toBe(true);
      if (!solo.ok || !viaBatch.ok) continue;
      expect(viaBatch.documents).toEqual(solo.documents);
      expect(viaBatch.fieldsReturned).toEqual(solo.fieldsReturned);
    }
  });
});

describe("queryBatch: partial failure is the contract", () => {
  it("a refused sub-query returns its own reason in its slot; the others still return documents, envelope ok:true", async () => {
    const ctx = makeCtx({ userId: "nogranthaver" }); // holds a grant on narrow, none on nogrant/items
    const batch = await broker.queryBatch(ctx, {
      queries: [
        { label: "ok1", collection: "narrow", fields: ["id"] },
        { label: "denied", collection: "nogrant" },
        { label: "ok2", collection: "narrow", fields: ["id"] },
      ],
    });
    expect(batch.ok, JSON.stringify(batch)).toBe(true);
    if (!batch.ok) return;
    expect(batch.results.ok1!.ok).toBe(true);
    expect(batch.results.ok2!.ok).toBe(true);
    expect(batch.results.denied!.ok).toBe(false);
    if (!batch.results.denied!.ok) expect(batch.results.denied!.reason).toBe("no_grant");
  });
});

describe("queryBatch: isolation — the main correctness risk", () => {
  const buildQueries = () => [
    { label: "filteredQ", collection: "filtered" },
    { label: "narrowQ", collection: "narrow" },
    { label: "maskedQ", collection: "masked" },
    { label: "aclQ", collection: "aclcol" },
    { label: "nograntQ", collection: "nogrant" },
  ];

  function assertMatrix(batch: { ok: true; results: Record<string, BrokerResult> }) {
    // document-filtered grant: only Engineering ever comes back.
    const filteredR = batch.results.filteredQ!;
    expect(filteredR.ok, JSON.stringify(filteredR)).toBe(true);
    if (filteredR.ok) {
      expect(filteredR.documents.length).toBe(2);
      expect(filteredR.documents.every((d) => d.dept === "Engineering")).toBe(true);
    }

    // narrow allowedFields: default projection never carries "b".
    const narrowR = batch.results.narrowQ!;
    expect(narrowR.ok, JSON.stringify(narrowR)).toBe(true);
    if (narrowR.ok) {
      expect(narrowR.fieldsReturned.sort()).toEqual(["a", "id"]);
      for (const doc of narrowR.documents) expect("b" in doc).toBe(false);
    }

    // masked field: comes back transformed, never raw.
    const maskedR = batch.results.maskedQ!;
    expect(maskedR.ok, JSON.stringify(maskedR)).toBe(true);
    if (maskedR.ok) {
      expect(maskedR.documents.length).toBe(2);
      for (const doc of maskedR.documents) expect(doc.secret).toBe("[redacted]");
    }

    // ACL'd collection: the restricted document never appears to a principal not on its ACL.
    const aclR = batch.results.aclQ!;
    expect(aclR.ok, JSON.stringify(aclR)).toBe(true);
    if (aclR.ok) {
      expect(aclR.documents.map((d) => d.id)).toEqual([aclPublicId]);
    }

    // no grant at all: refused, and refused independently of every other slot's success.
    const nograntR = batch.results.nograntQ!;
    expect(nograntR.ok).toBe(false);
    if (!nograntR.ok) expect(nograntR.reason).toBe("no_grant");
  }

  it("holds for the batch in its given order", async () => {
    const ctx = makeCtx({ userId: ISO });
    const batch = await broker.queryBatch(ctx, { queries: buildQueries() });
    expect(batch.ok, JSON.stringify(batch)).toBe(true);
    if (!batch.ok) return;
    assertMatrix(batch);
  });

  it("holds identically with the sub-queries reversed — order changes nothing", async () => {
    const ctx = makeCtx({ userId: ISO });
    const batch = await broker.queryBatch(ctx, { queries: buildQueries().reverse() });
    expect(batch.ok, JSON.stringify(batch)).toBe(true);
    if (!batch.ok) return;
    assertMatrix(batch);
  });
});

describe("queryBatch: audit — one row per sub-query, plus one for the envelope", () => {
  it("an N-query batch (allows and a refusal both) writes N+1 audit rows", async () => {
    const ctx = makeCtx({ userId: ISO });
    const batch = await broker.queryBatch(ctx, {
      queries: [
        { label: "a", collection: "filtered" },
        { label: "b", collection: "narrow" },
        { label: "c", collection: "nogrant" }, // refuses
      ],
    });
    expect(batch.ok, JSON.stringify(batch)).toBe(true);
    if (!batch.ok) return;

    const subIds = Object.values(batch.results).map((r) => r.auditId);
    const rows = await auditRows([...subIds, batch.auditId]);
    expect(rows.length).toBe(4); // 3 sub-queries + 1 envelope
    const envelopeRow = rows.find((r) => r.collection === "*");
    expect(envelopeRow?.outcome).toBe("allowed");
    const refusedRow = rows.find((r) => r.reason === "no_grant");
    expect(refusedRow?.outcome).toBe("refused");
    expect(rows.filter((r) => r.outcome === "allowed").length).toBe(3); // 2 sub allows + envelope
  });
});

describe("queryBatch: envelope refusals audit nothing per-collection", () => {
  it("duplicate labels -> invalid_intent, zero per-collection audit rows", async () => {
    const ctx = makeCtx({ userId: ISO });
    const before = await admin.query(
      `select count(*)::int as n from app.audit_events where collection = 'filtered'`,
    );
    const result = await broker.queryBatch(ctx, {
      queries: [
        { label: "dup", collection: "filtered" },
        { label: "dup", collection: "narrow" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_intent");

    const after = await admin.query(
      `select count(*)::int as n from app.audit_events where collection = 'filtered'`,
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);

    const envelope = await admin.query(
      `select collection, reason from app.audit_events where id = $1`,
      [result.auditId],
    );
    expect(envelope.rows[0]).toEqual({ collection: "*", reason: "invalid_intent" });
  });

  it("MAX_BATCH_QUERIES + 1 -> invalid_intent, zero per-collection audit rows", async () => {
    const ctx = makeCtx({ userId: ISO });
    const before = await admin.query(
      `select count(*)::int as n from app.audit_events where collection = 'filtered'`,
    );
    const queries = Array.from({ length: 11 }, (_, i) => ({
      label: `q${i}`,
      collection: "filtered",
    }));
    const result = await broker.queryBatch(ctx, { queries });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_intent");

    const after = await admin.query(
      `select count(*)::int as n from app.audit_events where collection = 'filtered'`,
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("queryBatch: combined with Phase 2's keyset `after`", () => {
  it("returns the sub-query's own nextCursor", async () => {
    const ctx = makeCtx({ userId: "walker" });
    const solo = await broker.query(ctx, {
      collection: "items",
      fields: ["id", "seq", "val"],
      orderBy: { field: "seq", dir: "asc" },
      limit: 2,
    });
    expect(solo.ok, JSON.stringify(solo)).toBe(true);
    if (!solo.ok) return;
    expect(solo.nextCursor).toBeDefined();

    const batch = await broker.queryBatch(ctx, {
      queries: [
        {
          label: "walk",
          collection: "items",
          fields: ["id", "seq", "val"],
          orderBy: { field: "seq", dir: "asc" },
          limit: 2,
        },
      ],
    });
    expect(batch.ok, JSON.stringify(batch)).toBe(true);
    if (!batch.ok) return;
    const walkResult = batch.results.walk!;
    expect(walkResult.ok).toBe(true);
    if (!walkResult.ok) return;
    expect(walkResult.nextCursor).toBe(solo.nextCursor);
    expect(walkResult.documents).toEqual(solo.documents);
  });
});

describe("queryBatch: structural checks (criteria 3.2 and 3.7)", () => {
  const SRC = readFileSync(resolve(__dirname, "../src/verbs/read.ts"), "utf8");
  const start = SRC.indexOf("async function queryBatch(");
  const end = SRC.indexOf("async function describeCollection(");
  const body = SRC.slice(start, end);

  it("queryBatch is present and bounded correctly for the extraction below", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("runs sequentially: no Promise.all anywhere in the function body", () => {
    expect(body).not.toContain("Promise.all");
    expect(body).toMatch(/for\s*\(const q of queries\)\s*{/);
    expect(body).toContain("await query(ctx, intent)");
  });

  it("hoists nothing out of the loop — calls query() per sub-query and nothing else touches a grant or the SQL builder", () => {
    for (const forbidden of ["loadActiveGrant", "resolveGranted", "maskPlan(", "buildSelect("]) {
      expect(body.includes(forbidden), `body should not contain "${forbidden}"`).toBe(false);
    }
  });
});
