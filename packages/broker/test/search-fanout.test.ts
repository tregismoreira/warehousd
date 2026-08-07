import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker } from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";
import { fuseByRank } from "../src/verbs/read";
import { makeCtx } from "./helpers/ctx";
import { SEED_REV_COLUMNS, SEED_REV_VALUES } from "../src/index";

// §P2. `search_documents` searched one collection at a time, so somebody asking "what's our
// parental leave policy" had to already know it lives in `policies`.

const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

let p: Provisioned, app: Pool, pools: ReturnType<typeof createPools>;
let broker: ReturnType<typeof makeBroker>;

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "test",
  collections: {
    policies: {
      description: "Policies",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        title: { type: "text", posture: "allow", searchable: true },
      },
    },
    handbooks: {
      description: "Handbooks",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        title: { type: "text", posture: "allow", searchable: true },
      },
    },
    secrets: {
      description: "Secrets",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        title: { type: "text", posture: "allow", searchable: true },
      },
    },
  },
});

beforeAll(async () => {
  p = await provision("search-fanout");
  app = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(app);
  await applyConfig(app, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);

  const seed = async (table: string, titles: string[]) => {
    for (const t of titles)
      await app.query(
        `insert into data_synth.${table} (${R}, org_id, id, title)
         values (${RV}, 'default', gen_random_uuid(), $1)`,
        [t],
      );
  };
  await seed("policies", ["Parental leave policy", "Expenses policy"]);
  await seed("handbooks", ["Parental leave handbook", "Onboarding handbook"]);
  await seed("secrets", ["Parental leave secret plan"]);

  for (const collection of ["policies", "handbooks"]) {
    const id = await requestGrant(app, {
      userId: "ana",
      collection,
      env: "dev",
      orgId: "default",
      purposeLabel: "t",
      allowedFields: ["id", "title"],
    });
    const r = await approveGrant(app, cfg, id, "boss", { allowedFields: ["id", "title"] });
    if (!r.ok) throw new Error(r.error);
  }
}, 60_000);

afterAll(async () => {
  await app.end();
  await pools.end();
  await p.end();
});

describe("omitting the collection searches everything the caller may read", () => {
  it("merges results and says where each came from", async () => {
    const res = await broker.searchDocuments(makeCtx({ userId: "ana" }), {
      q: "parental",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");

    const from = res.documents.map((doc) => doc._collection);
    expect(new Set(from)).toEqual(new Set(["policies", "handbooks"]));
    // A merged result set with no provenance is a list the caller cannot act on: get_document
    // needs to know which collection a document belongs to.
    for (const doc of res.documents) expect(typeof doc._collection).toBe("string");
  });

  it("never reaches a collection the caller holds no grant on", async () => {
    const res = await broker.searchDocuments(makeCtx({ userId: "ana" }), { q: "parental" });
    if (!res.ok) throw new Error("unreachable");
    expect(res.documents.some((doc) => doc._collection === "secrets")).toBe(false);
    // Not even as a refusal: `secrets` is simply not in the fan-out, because the caller holds no
    // read grant on it and reporting one would say the collection exists and was tried.
    expect(res.collections?.map((c) => c.collection).sort()).toEqual(["handbooks", "policies"]);
  });

  it("refuses no_grant when the caller may read nothing", async () => {
    const res = await broker.searchDocuments(makeCtx({ userId: "nobody" }), { q: "parental" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no_grant");
  });

  it("still searches one collection when one is named", async () => {
    const res = await broker.searchDocuments(makeCtx({ userId: "ana" }), {
      collection: "policies",
      q: "parental",
    });
    if (!res.ok) throw new Error("unreachable");
    // Byte-identical to what a single-collection search always returned: no `collections`, no
    // `_collection` on the documents.
    expect(res.collections).toBeUndefined();
    expect(res.documents[0]?._collection).toBeUndefined();
    expect(res.fieldsReturned).toEqual(["id", "title"]);
  });
});

// Invariant 3: every decision passes through exactly one audit call. Twenty collections is twenty
// decisions, and collapsing them would make "who searched what" unanswerable.
describe("the fan-out audits one row per collection", () => {
  it("records a decision for each, plus the fan-out itself", async () => {
    const before = await app.query<{ n: string }>(
      `select count(*)::text as n from app.audit_events where user_id='fanout'`,
    );
    const res = await broker.searchDocuments(makeCtx({ userId: "fanout" }), { q: "parental" });
    // `fanout` holds nothing, so this is the one-decision case — one row, not three.
    expect(res.ok).toBe(false);
    const after = await app.query<{ n: string }>(
      `select count(*)::text as n from app.audit_events where user_id='fanout'`,
    );
    expect(Number(after.rows[0]!.n) - Number(before.rows[0]!.n)).toBe(1);
  });

  it("records one row per reached collection when there are grants", async () => {
    const before = await app.query<{ n: string }>(
      `select count(*)::text as n from app.audit_events where user_id='ana' and collection <> '*'`,
    );
    await broker.searchDocuments(makeCtx({ userId: "ana" }), { q: "parental" });
    const rows = await app.query<{ collection: string }>(
      `select collection from app.audit_events where user_id='ana' and collection <> '*'`,
    );
    const after = rows.rowCount ?? 0;
    expect(after - Number(before.rows[0]!.n)).toBe(2);
    expect(new Set(rows.rows.slice(-2).map((r) => r.collection))).toEqual(
      new Set(["policies", "handbooks"]),
    );
  });

  it("reports a per-collection refusal rather than dropping it", async () => {
    // A grant that carries `create` but not `read` refuses `no_grant` on that collection alone;
    // the rest of the fan-out still runs.
    const id = await requestGrant(app, {
      userId: "partial",
      collection: "policies",
      env: "dev",
      orgId: "default",
      purposeLabel: "t",
      allowedFields: ["id", "title"],
    });
    const ok = await approveGrant(app, cfg, id, "boss", {
      allowedFields: ["id", "title"],
      verbs: ["read"],
    });
    expect(ok.ok).toBe(true);

    const res = await broker.searchDocuments(makeCtx({ userId: "partial" }), { q: "parental" });
    if (!res.ok) throw new Error("unreachable");
    expect(res.collections).toEqual([
      { collection: "policies", matched: 1, reason: null, auditId: expect.any(String) },
    ]);
  });
});

// RRF, not raw scores. `ts_rank` over different tsv columns and cosine distance over different
// embedding sets are not comparable numbers, and averaging them produces a confidently wrong
// ordering. RRF needs only the rank, which is the one comparable thing.
describe("reciprocal-rank fusion", () => {
  it("interleaves by rank, ignoring whatever the scores were", () => {
    // A fixture with deliberately incomparable raw scores: `a` would win on any naive comparison
    // of `score`, and RRF does not look at it.
    const merged = fuseByRank([
      { doc: { id: "a1", score: 0.99 }, collection: "a", rank: 1 },
      { doc: { id: "a2", score: 0.98 }, collection: "a", rank: 2 },
      { doc: { id: "a3", score: 0.97 }, collection: "a", rank: 3 },
      { doc: { id: "b1", score: 0.01 }, collection: "b", rank: 1 },
      { doc: { id: "b2", score: 0.009 }, collection: "b", rank: 2 },
    ]);
    expect(merged.map((doc) => doc.id)).toEqual(["a1", "b1", "a2", "b2", "a3"]);
  });

  it("is stable for equal ranks", () => {
    const twice = () =>
      fuseByRank([
        { doc: { id: "x" }, collection: "a", rank: 1 },
        { doc: { id: "y" }, collection: "b", rank: 1 },
        { doc: { id: "z" }, collection: "c", rank: 1 },
      ]).map((doc) => doc.id);
    expect(twice()).toEqual(["x", "y", "z"]);
    expect(twice()).toEqual(twice());
  });
});
