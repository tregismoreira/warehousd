import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { loadActiveGrant } from "../src/grants/eval";
import { loadConfig, ConfigSchema } from "../src/config/schema";
import { applyConfig } from "../src/apply/apply";
import { createPools, makeBroker } from "../src/index";
import type { BrokerContext } from "../src/types";

let p: Provisioned;
afterAll(async () => { await p?.end(); });

describe("collection ceiling", () => {
  it("user with grant on collection outside ceiling is refused through that client", async () => {
    p = await provision("collectionceiling");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);

    const config = ConfigSchema.parse({
      project: "test",
      collections: {
        campaigns: { description: "Campaigns", fields: { id: { type: "uuid", pk: true, posture: "allow" } } },
        salaries: { description: "Salaries", fields: { id: { type: "uuid", pk: true, posture: "allow" } } },
      },
    });
    await applyConfig(db, config);

    // Insert a grant for the user on salaries
    await db.query(
      `insert into app.grants
         (user_id, collection, env, status, org_id, verbs, mode)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      ["user1", "salaries", "dev", "approved", "default", ["read"], "direct"]);

    // Set the client policy ceiling to only campaigns (not salaries)
    await db.query(
      `insert into app.client_policies (client_id, allowed_collections, org_id)
       values ($1, $2, $3)`,
      ["client1", ["campaigns"], "default"]);

    // Without ceiling, user has grant on salaries
    let grant = await loadActiveGrant(db, { userId: "user1", env: "dev", orgId: "default" }, "salaries");
    expect(grant).not.toBeNull();

    // With ceiling excluding salaries, user is refused (returns null)
    grant = await loadActiveGrant(db, { userId: "user1", env: "dev", orgId: "default", allowedCollections: ["campaigns"] }, "salaries");
    expect(grant).toBeNull();

    // With ceiling including salaries, user still has the grant
    grant = await loadActiveGrant(db, { userId: "user1", env: "dev", orgId: "default", allowedCollections: ["salaries"] }, "salaries");
    expect(grant).not.toBeNull();

    await db.end();
  });

  it("refusal from ceiling is indistinguishable from no_grant", async () => {
    p = await provision("collectionceiling");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);

    const config = ConfigSchema.parse({
      project: "test",
      collections: {
        campaigns: { description: "Campaigns", fields: { id: { type: "uuid", pk: true, posture: "allow" } } },
        salaries: { description: "Salaries", fields: { id: { type: "uuid", pk: true, posture: "allow" } } },
      },
    });
    await applyConfig(db, config);

    // No grant at all
    let grant = await loadActiveGrant(db, { userId: "user2", env: "dev", orgId: "default" }, "salaries");
    expect(grant).toBeNull();

    // Grant exists but ceiling excludes it
    await db.query(
      `insert into app.grants
         (user_id, collection, env, status, org_id, verbs, mode)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      ["user2", "salaries", "dev", "approved", "default", ["read"], "direct"]);

    grant = await loadActiveGrant(db, { userId: "user2", env: "dev", orgId: "default", allowedCollections: ["campaigns"] }, "salaries");
    expect(grant).toBeNull(); // Same result as no grant

    await db.end();
  });

  it("ceiling can never widen access beyond user's grants", async () => {
    p = await provision("collectionceiling");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);

    const config = ConfigSchema.parse({
      project: "test",
      collections: {
        campaigns: { description: "Campaigns", fields: { id: { type: "uuid", pk: true, posture: "allow" } } },
        salaries: { description: "Salaries", fields: { id: { type: "uuid", pk: true, posture: "allow" } } },
      },
    });
    await applyConfig(db, config);

    // User has grant only on campaigns
    await db.query(
      `insert into app.grants
         (user_id, collection, env, status, org_id, verbs, mode)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      ["user3", "campaigns", "dev", "approved", "default", ["read"], "direct"]);

    // Even if ceiling allows salaries, user still can't access it (no grant)
    let grant = await loadActiveGrant(db, { userId: "user3", env: "dev", orgId: "default", allowedCollections: ["salaries", "campaigns"] }, "salaries");
    expect(grant).toBeNull();

    // But can access campaigns which both user and ceiling allow
    grant = await loadActiveGrant(db, { userId: "user3", env: "dev", orgId: "default", allowedCollections: ["salaries", "campaigns"] }, "campaigns");
    expect(grant).not.toBeNull();

    await db.end();
  });

  it("null ceiling behaves exactly as before this phase", async () => {
    p = await provision("collectionceiling");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);

    const config = ConfigSchema.parse({
      project: "test",
      collections: {
        campaigns: { description: "Campaigns", fields: { id: { type: "uuid", pk: true, posture: "allow" } } },
      },
    });
    await applyConfig(db, config);

    // User has grant
    await db.query(
      `insert into app.grants
         (user_id, collection, env, status, org_id, verbs, mode)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      ["user4", "campaigns", "dev", "approved", "default", ["read"], "direct"]);

    // With null ceiling (no restriction), grant is visible
    let grant = await loadActiveGrant(db, { userId: "user4", env: "dev", orgId: "default", allowedCollections: null }, "campaigns");
    expect(grant).not.toBeNull();

    // With undefined ceiling (also no restriction), grant is visible
    grant = await loadActiveGrant(db, { userId: "user4", env: "dev", orgId: "default", allowedCollections: undefined }, "campaigns");
    expect(grant).not.toBeNull();

    // With empty array ceiling, grant is rejected (not in the empty set)
    grant = await loadActiveGrant(db, { userId: "user4", env: "dev", orgId: "default", allowedCollections: [] }, "campaigns");
    expect(grant).toBeNull();

    await db.end();
  });
});

// listCollections is the one verb that does not route through loadActiveGrant, so the ceiling had
// to be applied to it by hand — and was not. A restricted client could read back the name and
// description of every collection in the config, including ones no grant it holds can reach.
describe("collection ceiling applies to discovery", () => {
  let lp: Provisioned, db: Pool, pools: any, broker: ReturnType<typeof makeBroker>;

  const config = ConfigSchema.parse({
    project: "test",
    collections: {
      campaigns: { description: "Campaigns", fields: { id: { type: "uuid", pk: true, posture: "allow" } } },
      salaries:  { description: "Salaries",  fields: { id: { type: "uuid", pk: true, posture: "allow" } } },
      policies:  { description: "Policies",  fields: { id: { type: "uuid", pk: true, posture: "allow" } } },
    },
  });

  beforeAll(async () => {
    lp = await provision("ceiling-discovery");
    db = new Pool({ connectionString: lp.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, config);
    pools = createPools({ app: lp.urls.admin, dev: lp.urls.dev, live: lp.urls.live,
      devWrite: lp.urls.devWrite, liveWrite: lp.urls.liveWrite });
    broker = makeBroker(pools, config);
  }, 60_000);

  afterAll(async () => { await db.end(); await pools.end(); await lp.end(); });

  const ctx = (allowedCollections?: string[] | null): BrokerContext =>
    ({ userId: "u", env: "dev", orgId: "default", ...(allowedCollections !== undefined ? { allowedCollections } : {}) });

  it("lists only collections inside the ceiling", async () => {
    const names = (await broker.listCollections(ctx(["campaigns", "policies"]))).map((c) => c.name);
    expect(names.sort()).toEqual(["campaigns", "policies"]);
  });

  it("does not leak the description of a collection outside the ceiling", async () => {
    // The description is the part worth withholding: it is prose written for humans and says what
    // the data is.
    const listed = await broker.listCollections(ctx(["campaigns"]));
    expect(JSON.stringify(listed)).not.toContain("Salaries");
  });

  it("lists nothing for an empty ceiling", async () => {
    expect(await broker.listCollections(ctx([]))).toEqual([]);
  });

  it("lists everything when no ceiling is set, by either spelling", async () => {
    // null and absent both mean "unrestricted", matching loadActiveGrant. A ceiling that defaulted
    // to closed here would break every first-party session, which carries no ceiling at all.
    for (const c of [ctx(null), ctx(undefined)])
      expect((await broker.listCollections(c)).map((x) => x.name).sort())
        .toEqual(["campaigns", "policies", "salaries"]);
  });

  it("still audits the call, ceiling or not", async () => {
    // The ceiling narrows what is returned; it does not make the call unobserved.
    const before = await db.query(`select count(*)::int as n from app.audit_events where collection = '*'`);
    await broker.listCollections(ctx(["campaigns"]));
    const after = await db.query(`select count(*)::int as n from app.audit_events where collection = '*'`);
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });
});
