import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import {
  createAppSchema,
  applyConfig,
  createPools,
  makeBroker,
  approveGrant,
  requestGrant,
  validateGrantRequest,
  SEED_REV_COLUMNS,
  SEED_REV_VALUES,
  type Pools,
} from "../src/index";
import { ConfigSchema } from "../src/config/schema";
import { MASK_KEY_ENV } from "../src/sql/mask";
import { FILTER_OPS, AGGREGATE_FNS } from "../src/intents/schema";
import { MASK_RAW_CANARY } from "./fixtures/canaries";
import { makeCtx } from "./helpers/ctx";
import { assertSchema } from "./helpers/results";
import { captureLogs } from "./helpers/log-capture";

// Masking, against a real Postgres. Two properties, and the second is the one that matters:
//
//   1. A masked field comes back transformed.
//   2. A masked field cannot be COMPUTED over — no filter, no ordering, no grouping, no
//      aggregate. Without that, the mask is decoration: `gt`/`lt` binary-search a bucketed
//      salary to the exact figure in about ten queries, `like` walks a redacted string one
//      character at a time, `orderBy` hands over the full ranking, and `min`/`max` return the
//      raw extremes outright.
//
// MASK_RAW_CANARY is planted in every masked column, so "the raw value never appears" is one
// assertion rather than a per-transform argument.

const cfg = ConfigSchema.parse({
  project: "maskenf",
  server: { port: 1 },
  collections: {
    staff: {
      description: "Staff",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        name: { type: "text", posture: "allow" },
        dept: { type: "text", posture: "allow" },
        // Masked, and never unmaskable: nobody sees these raw without editing the config.
        ssn: {
          type: "text",
          posture: { read: "mask", write: "deny" },
          mask: { transform: "last4" },
        },
        email: {
          type: "text",
          posture: { read: "mask", write: "deny" },
          mask: { transform: "domain" },
        },
        pseudonym: {
          type: "text",
          posture: { read: "mask", write: "deny" },
          mask: { transform: "hash" },
        },
        hired: {
          type: "date",
          posture: { read: "mask", write: "deny" },
          mask: { transform: "year" },
        },
        note: {
          type: "text",
          posture: { read: "mask", write: "deny" },
          mask: { transform: "redact" },
        },
        // Masked by default, but the raw value is grantable — a manager may tick it.
        salary: {
          type: "numeric",
          posture: { read: "mask", write: "deny", unmask: "allow" },
          mask: { transform: "bucket", width: 25000 },
        },
        secret: { type: "text", posture: "deny" },
      },
    },
  },
});

const GRANTABLE = ["id", "name", "dept", "ssn", "email", "pseudonym", "hired", "note", "salary"];

let p: Provisioned, admin: Pool, pools: Pools, broker: ReturnType<typeof makeBroker>;
const ID = (n: number) => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);

const ctx = (userId: string) => makeCtx({ userId, env: "live" });

beforeAll(async () => {
  process.env[MASK_KEY_ENV] = "test-mask-key";
  p = await provision("maskenf");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);

  await admin.query(
    `insert into data_live.staff (${SEED_REV_COLUMNS}, id, name, dept, ssn, email, pseudonym, hired, note, salary, secret)
     values (${SEED_REV_VALUES}, $1,'Ada','eng',$2,$3,$4,'2019-03-04',$5,97300,$6)`,
    [
      ID(1),
      `${MASK_RAW_CANARY}-6789`,
      `${MASK_RAW_CANARY}@example.com`,
      MASK_RAW_CANARY,
      MASK_RAW_CANARY,
      MASK_RAW_CANARY,
    ],
  );
  await admin.query(
    `insert into data_live.staff (${SEED_REV_COLUMNS}, id, name, dept, ssn, email, pseudonym, hired, note, salary, secret)
     values (${SEED_REV_VALUES}, $1,'Grace','fin',$2,$3,$4,'2021-07-01',$5,42000,$6)`,
    [
      ID(2),
      `${MASK_RAW_CANARY}-1111`,
      `${MASK_RAW_CANARY}@other.com`,
      MASK_RAW_CANARY,
      MASK_RAW_CANARY,
      MASK_RAW_CANARY,
    ],
  );

  // mia: every grantable field, nothing unmasked. ana: the same, plus raw salary.
  await admin.query(
    `insert into app.grants (user_id, collection, allowed_fields, env, status)
     values ('mia','staff',$1,'live','approved')`,
    [GRANTABLE],
  );
  await admin.query(
    `insert into app.grants (user_id, collection, allowed_fields, unmasked_fields, env, status)
     values ('ana','staff',$1,$2,'live','approved')`,
    [GRANTABLE, ["salary"]],
  );
}, 60_000);

afterAll(async () => {
  delete process.env[MASK_KEY_ENV];
  await admin.end();
  await pools.end();
  await p.end();
});

describe("a masked field cannot be computed over", () => {
  // Every operator the intent schema admits, against a masked column. One of these getting
  // through is the whole attack: `gt`/`lt` alone recover a bucketed number by bisection.
  it.each(FILTER_OPS)("refuses filter op %s", async (op) => {
    const r = await broker.query(ctx("mia"), {
      collection: "staff",
      fields: ["id"],
      filters: [{ field: "ssn", op, value: op === "in" ? ["x"] : "x" }],
    });
    expect(r).toMatchObject({ ok: false, reason: "field_denied" });
  });

  it("refuses orderBy on a masked field", async () => {
    for (const dir of ["asc", "desc"] as const) {
      const r = await broker.query(ctx("mia"), {
        collection: "staff",
        fields: ["id"],
        orderBy: { field: "salary", dir },
      });
      expect(r).toMatchObject({ ok: false, reason: "field_denied" });
    }
  });

  it.each(AGGREGATE_FNS)("refuses aggregate %s over a masked field", async (fn) => {
    const r = await broker.query(ctx("mia"), {
      collection: "staff",
      aggregate: [{ fn, field: "salary" }],
    });
    expect(r).toMatchObject({ ok: false, reason: "field_denied" });
  });

  it("refuses groupBy on a masked field", async () => {
    const r = await broker.query(ctx("mia"), {
      collection: "staff",
      aggregate: [{ fn: "count", field: "id" }],
      groupBy: ["ssn"],
    });
    expect(r).toMatchObject({ ok: false, reason: "field_denied" });
  });

  it("still allows all of those on an UNMASKED field", async () => {
    // The guard has to be about the mask, not about the collection.
    const r = await broker.query(ctx("mia"), {
      collection: "staff",
      fields: ["id", "name"],
      filters: [{ field: "dept", op: "eq", value: "eng" }],
      orderBy: { field: "name", dir: "asc" },
    });
    expect(r.ok).toBe(true);
  });

  it("allows computing over a field this caller holds UNMASKED", async () => {
    // ana's grant carries raw salary, so for her it is not a masked field and the guard must
    // not fire. A rule keyed on the config alone rather than on the grant would refuse here.
    const r = await broker.query(ctx("ana"), {
      collection: "staff",
      aggregate: [{ fn: "avg", field: "salary" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(Number(r.documents[0]!.avg_salary)).toBeCloseTo((97300 + 42000) / 2, 0);
  });
});

describe("a masked field comes back transformed", () => {
  it("never returns the raw value, in the response or in the logs", async () => {
    const logs = captureLogs();
    try {
      const r = await broker.query(ctx("mia"), {
        collection: "staff",
        fields: ["id", "ssn", "email", "pseudonym", "hired", "note", "salary"],
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("unreachable");
      expect(JSON.stringify(r.documents)).not.toContain(MASK_RAW_CANARY);
      expect(logs.text()).not.toContain(MASK_RAW_CANARY);
    } finally {
      logs.restore();
    }
  });

  it("applies each transform", async () => {
    const r = await broker.query(ctx("mia"), {
      collection: "staff",
      fields: ["id", "ssn", "email", "pseudonym", "hired", "note", "salary"],
      filters: [{ field: "id", op: "eq", value: ID(1) }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const row = r.documents[0]!;
    expect(row.ssn).toBe("••••6789");
    expect(row.email).toBe("example.com");
    expect(row.hired).toBe(2019);
    expect(row.note).toBe("[redacted]");
    // Quantised, not merely relabelled: 97_300 with width 25_000 is the 75_000 band. A mask
    // that returned 97_300 under a different name would pass every other assertion here.
    expect(Number(row.salary)).toBe(75000);
    expect(String(row.pseudonym)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes deterministically within a deployment and differently across keys", async () => {
    const read = async () => {
      const r = await broker.query(ctx("mia"), {
        collection: "staff",
        fields: ["pseudonym"],
        filters: [{ field: "id", op: "eq", value: ID(1) }],
      });
      if (!r.ok) throw new Error(`expected a read, got ${r.reason}`);
      return String(r.documents[0]!.pseudonym);
    };
    const a = await read();
    expect(await read()).toBe(a);
    process.env[MASK_KEY_ENV] = "a-different-key";
    expect(await read()).not.toBe(a);
    process.env[MASK_KEY_ENV] = "test-mask-key";
  });

  it("returns the same masked value through getDocument", async () => {
    const r = await broker.getDocument(ctx("mia"), { collection: "staff", id: ID(1) });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.document.ssn).toBe("••••6789");
    expect(JSON.stringify(r.document)).not.toContain(MASK_RAW_CANARY);
  });

  it("returns raw to a grant that carries unmask, and records that in the audit row", async () => {
    const r = await broker.query(ctx("ana"), {
      collection: "staff",
      fields: ["id", "salary", "ssn"],
      filters: [{ field: "id", op: "eq", value: ID(1) }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    // salary raw, ssn still masked — unmask is per field, not per grant.
    expect(Number(r.documents[0]!.salary)).toBe(97300);
    expect(r.documents[0]!.ssn).toBe("••••6789");

    const ev = await admin.query(`select unmasked_fields from app.audit_events where id=$1`, [
      r.auditId,
    ]);
    expect(ev.rows[0].unmasked_fields).toEqual(["salary"]);
  });

  it("records an empty unmask list for a caller who saw nothing raw", async () => {
    const r = await broker.query(ctx("mia"), { collection: "staff", fields: ["id", "salary"] });
    if (!r.ok) throw new Error("unreachable");
    const ev = await admin.query(`select unmasked_fields from app.audit_events where id=$1`, [
      r.auditId,
    ]);
    expect(ev.rows[0].unmasked_fields).toEqual([]);
  });
});

describe("the grant is the only thing that can widen a mask", () => {
  const pending = (userId: string, allowedFields: string[]) =>
    requestGrant(admin, {
      userId,
      collection: "staff",
      env: "live",
      purposeLabel: "p",
      allowedFields,
    });

  it("refuses to approve an unmask on a field the config does not offer", async () => {
    // ssn is masked but its posture does not say `unmask: allow`, so no grant can widen it.
    const id = await pending("eve", ["id", "ssn"]);
    const r = await approveGrant(admin, cfg, id, "marcus", {
      allowedFields: ["id", "ssn"],
      unmaskedFields: ["ssn"],
    });
    expect(r).toMatchObject({ ok: false, error: "invalid_unmask" });
  });

  it("refuses to unmask a field the grant does not even carry", async () => {
    const id = await pending("eve2", ["id"]);
    const r = await approveGrant(admin, cfg, id, "marcus", {
      allowedFields: ["id"],
      unmaskedFields: ["salary"],
    });
    expect(r).toMatchObject({ ok: false, error: "invalid_unmask" });
  });

  it("approves the unmask the config does offer", async () => {
    const id = await pending("eve4", ["id", "salary"]);
    const r = await approveGrant(admin, cfg, id, "marcus", {
      allowedFields: ["id", "salary"],
      unmaskedFields: ["salary"],
    });
    expect(r).toMatchObject({ ok: true });
    const g = await admin.query(`select unmasked_fields from app.grants where id=$1`, [id]);
    expect(g.rows[0].unmasked_fields).toEqual(["salary"]);
  });

  it("still refuses a field whose posture is deny outright", () => {
    // `mask` widened grantableFields; `deny` must not have come along for the ride.
    expect(validateGrantRequest(cfg, "staff", "p", ["id", "secret"])).toMatchObject({
      ok: false,
      error: "field_not_grantable",
    });
    expect(validateGrantRequest(cfg, "staff", "p", ["id", "ssn"])).toMatchObject({ ok: true });
  });
});

describe("describeCollection tells the caller which fields are masked", () => {
  it("marks the masked ones and leaves the rest alone", async () => {
    const s = await broker.describeCollection(ctx("mia"), "staff");
    assertSchema(s);
    const by = Object.fromEntries(s.fields.map((f) => [f.name, f]));
    expect(by.ssn).toMatchObject({ masked: true });
    expect(by.name!.masked).toBeUndefined();
    // A caller that does not know a field is transformed will filter on it, get field_denied,
    // and have no way to tell that from a field they were never granted.
    expect(by.secret).toBeUndefined();
  });

  it("does not mark a field this caller holds unmasked", async () => {
    const s = await broker.describeCollection(ctx("ana"), "staff");
    assertSchema(s);
    const by = Object.fromEntries(s.fields.map((f) => [f.name, f]));
    expect(by.salary!.masked).toBeUndefined();
    expect(by.ssn).toMatchObject({ masked: true });
  });
});

describe("a masked field can still gate documents through a grant filter", () => {
  it("scopes by a masked column without disclosing it", async () => {
    // The deliberate exception, and the same precedent `path: deny` already sets: a document
    // filter is written by a human manager, not by the model, so it may reference a column the
    // caller cannot read. What the caller gets is fewer documents, not a value.
    await admin.query(
      `insert into app.grants (user_id, collection, allowed_fields, env, status, document_filter)
       values ('scoped','staff',$1,'live','approved',$2)`,
      [GRANTABLE, JSON.stringify([{ field: "salary", op: "eq", value: 42000 }])],
    );
    const r = await broker.query(ctx("scoped"), { collection: "staff", fields: ["id", "name"] });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.documents).toHaveLength(1);
    expect(r.documents[0]!.name).toBe("Grace");
  });
});
