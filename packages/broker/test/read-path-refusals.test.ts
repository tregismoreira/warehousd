import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, makeBroker } from "../src/index";
import { requestGrant, approveGrant } from "../src/grants/manage";
import type { WarehousdConfig } from "../src/config/schema";
import { ConfigSchema } from "../src/config/schema";
import { makeCtx } from "./helpers/ctx";

import { SEED_REV_COLUMNS, SEED_REV_VALUES } from "../src/index";

// Every dataset table carries NOT NULL revision bookkeeping, so a fixture insert has to
// be a well-formed `create` revision. These are literals; every value stays bound.
const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

// The narrow refusals on the read verbs: a grant that carries a verb other than `read`, and a
// grant whose document filter cannot be evaluated at all.
//
// The second is the one worth having. An unevaluable filter has to refuse identically on every
// verb that consults it — query, search, getDocument, approve — because the alternative is a
// grant whose document scope means one thing on one verb and something else on another, and the
// difference between `invalid_intent` and `not_found` is the difference between "your grant is
// wrong" and "that document does not exist", which is a disclosure.
let p: Provisioned, app: Pool, pools: any;

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "test",
  collections: {
    people: {
      description: "People",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        email: { type: "text", posture: "allow", searchable: true },
        dept: { type: "text", posture: "allow" },
      },
    },
  },
});

let broker: ReturnType<typeof makeBroker>;

beforeAll(async () => {
  p = await provision("read-path-refusals");
  app = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(app);
  await applyConfig(app, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);

  await app.query(
    `insert into data_synth.people (${R}, workspace_id, id, email, dept)
     values (${RV}, 'default', gen_random_uuid(), 'seed@ex.com', 'Engineering')`,
  );
}, 60_000);

afterAll(async () => {
  await app.end();
  await pools.end();
  await p.end();
});

// `verbs` and `documentFilters` are the two dimensions every test here varies; the rest of a
// grant is noise.
async function grantFor(
  userId: string,
  opts: { verbs?: string[]; documentFilters?: { field: string; op: string; value: unknown }[] },
) {
  const id = await requestGrant(app, {
    userId,
    collection: "people",
    env: "dev",
    workspaceId: "default",
    purposeLabel: "test",
    allowedFields: ["id", "email", "dept"],
  });
  await approveGrant(app, cfg, id, "admin", { verbs: opts.verbs ?? ["read"] });
  // The filter is written past approveGrant deliberately. Approval now refuses a predicate it
  // cannot evaluate (`invalid_filter`), so the only way an approved grant carries one is that the
  // config changed after the decision — a field renamed, a type narrowed. That is the state these
  // tests exercise, and the reason the use-time check stays where it is.
  if (opts.documentFilters)
    await app.query(`update app.grants set document_filter=$2 where id=$1`, [
      id,
      JSON.stringify(opts.documentFilters),
    ]);
  return makeCtx({ userId });
}

const badField = [{ field: "nosuchfield", op: "eq", value: "x" }];
const badValue = [{ field: "id", op: "eq", value: "not-a-uuid" }];

describe("read verbs refuse a grant that cannot read", () => {
  // A grant carrying only `create` is not a read grant, and describe is a read: it returns the
  // field list, which is itself information about the collection's shape.
  it("describeCollection refuses no_grant when the grant lacks the read verb", async () => {
    const ctx = await grantFor("describe_nowrite", { verbs: ["create"] });
    const res = await broker.describeCollection(ctx, "people");
    expect("ok" in res && res.ok === false).toBe(true);
    if ("reason" in res) expect(res.reason).toBe("no_grant");
  });

  it("searchDocuments refuses no_grant on the same grant", async () => {
    const ctx = await grantFor("search_nowrite", { verbs: ["create"] });
    const res = await broker.searchDocuments(ctx, { collection: "people", q: "seed" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no_grant");
  });
});

describe("read verbs refuse an unevaluable document filter the same way", () => {
  it("searchDocuments refuses invalid_intent for a filter naming an unknown field", async () => {
    const ctx = await grantFor("search_badfilter", { documentFilters: badField });
    const res = await broker.searchDocuments(ctx, { collection: "people", q: "seed" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid_intent");
    expect(JSON.stringify(res)).not.toContain("nosuchfield");
  });

  it("getDocument refuses invalid_intent for the same filter", async () => {
    const ctx = await grantFor("get_badfilter", { documentFilters: badField });
    const row = await app.query(`select id from data_synth.people limit 1`);
    const res = await broker.getDocument(ctx, { collection: "people", id: row.rows[0].id });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid_intent");
  });

  it("getDocument refuses invalid_intent when the filter's value is not of the field's type", async () => {
    const ctx = await grantFor("get_badvalue", { documentFilters: badValue });
    const row = await app.query(`select id from data_synth.people limit 1`);
    const res = await broker.getDocument(ctx, { collection: "people", id: row.rows[0].id });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid_intent");
  });
});

describe("searchDocuments rejects a query it cannot run", () => {
  // Blank and whitespace-only are the same case to a full-text search, and both have to be the
  // caller's error rather than an empty result set that reads like "nothing matched".
  it("refuses invalid_intent for an empty q", async () => {
    const ctx = await grantFor("search_emptyq", {});
    const res = await broker.searchDocuments(ctx, { collection: "people", q: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid_intent");
  });

  it("refuses invalid_intent for a whitespace-only q", async () => {
    const ctx = await grantFor("search_blankq", {});
    const res = await broker.searchDocuments(ctx, { collection: "people", q: "   " });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid_intent");
  });
});
