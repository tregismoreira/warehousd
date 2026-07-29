import { describe, it, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { loadActiveGrant } from "../src/grants/eval";
import { loadConfig, ConfigSchema } from "../src/config/schema";
import { applyConfig } from "../src/apply/apply";

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
