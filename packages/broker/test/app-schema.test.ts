import { describe, it, expect, afterAll } from "vitest";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";

let p: Provisioned;
afterAll(async () => {
  await p?.end();
});

describe("app schema", () => {
  it("creates collections, grants, audit_events tables", async () => {
    p = await provision("appschema");
    const db = testPool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    const r = await db.query(
      `select table_name from information_schema.tables where table_schema='app' order by table_name`,
    );
    await db.end();
    expect(r.rows.map((x) => x.table_name)).toEqual([
      "audit_events",
      "change_log",
      "client_policies",
      "client_secrets",
      // The ledger for the project's own migrations — the SQL files that unblock a destructive
      // collection change. Separate from schema_migrations, which tracks this repository's.
      "collection_migrations",
      "collections",
      "grants",
      "login_attempts",
      // The /v1/platform bearer credential — above the workspace boundary, see credentials/platform-keys.ts.
      "platform_keys",
      // The migration ledger itself. It is created by the runner rather than by a migration,
      // so it exists before 0001 does anything — see packages/broker/src/db/migrate.ts.
      "schema_migrations",
      // Which (user, provider) pairs have been provisioned once. It keeps SSO role provisioning a
      // first-login act while group membership syncs on every login — see apps/web/lib/sso.ts.
      "sso_provisioned",
      "terms",
      "trusted_issuers",
      // Warehousd's own record of who is in which group, and therefore what a `group:` principal
      // on a per-document ACL resolves against. Never read from a token — see acl/principals.ts.
      "user_groups",
      "vocabularies",
      // Per-workspace role membership — see packages/broker/src/workspaces/members.ts.
      "workspace_members",
      "workspaces",
    ]);
  });

  it("bootstraps exactly one implicit workspace, and stays at one across re-runs", async () => {
    p = await provision("appschema");
    const db = testPool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await createAppSchema(db);
    const r = await db.query(`select id from app.workspaces`);
    await db.end();
    expect(r.rows.map((x) => x.id)).toEqual(["default"]);
  });

  it("workspace_id defaults to the implicit workspace on every governed table", async () => {
    p = await provision("appschema");
    const db = testPool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await db.query(
      `insert into app.grants (user_id, collection, env, status) values ('u','people','dev','pending')`,
    );
    await db.query(
      `insert into app.audit_events (user_id, env, collection, outcome) values ('u','dev','people','allowed')`,
    );
    await db.query(`insert into app.collections (name, description) values ('people','People')`);
    await db.query(`insert into app.client_policies (client_id) values ('c1')`);
    for (const t of ["grants", "audit_events", "collections", "client_policies"]) {
      const r = await db.query(`select workspace_id from app.${t}`);
      expect(r.rows.every((x) => x.workspace_id === "default")).toBe(true);
    }
    await db.end();
  });
});

describe("taxonomy tables", () => {
  it("vocabularies: slug unique; terms: (vocabulary_id, slug) unique, parent_id reserved-null", async () => {
    p = await provision("appschema");
    const db = testPool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    const vid = (
      await db.query(
        `insert into app.vocabularies (slug, label) values ('category','Category') returning id`,
      )
    ).rows[0].id;
    await expect(
      db.query(`insert into app.vocabularies (slug, label) values ('category','Again')`),
    ).rejects.toThrow();
    await db.query(`insert into app.terms (vocabulary_id, slug, label) values ($1,'hr','HR')`, [
      vid,
    ]);
    await expect(
      db.query(`insert into app.terms (vocabulary_id, slug, label) values ($1,'hr','HR again')`, [
        vid,
      ]),
    ).rejects.toThrow();
    const t = (await db.query(`select parent_id from app.terms where slug='hr'`)).rows[0];
    expect(t.parent_id).toBeNull(); // hierarchy column reserved, unused in MVP
    await db.end();
  });

  it("cascade-deletes terms with their vocabulary", async () => {
    p = await provision("appschema");
    const db = testPool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    const vid = (
      await db.query(`insert into app.vocabularies (slug, label) values ('tmp','Tmp') returning id`)
    ).rows[0].id;
    await db.query(`insert into app.terms (vocabulary_id, slug, label) values ($1,'x','X')`, [vid]);
    await db.query(`delete from app.vocabularies where id=$1`, [vid]);
    const left = await db.query(`select 1 from app.terms where vocabulary_id=$1`, [vid]);
    expect(left.rowCount).toBe(0);
    await db.end();
  });
});

describe("client_policies table", () => {
  it("creates app.client_policies with the default allow-list", async () => {
    p = await provision("appschema");
    const db = testPool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    const r = await db.query(`
      insert into app.client_policies (client_id, display_name) values ('c1', 'Test Client')
      returning allowed_scopes`);
    expect(r.rows[0].allowed_scopes).toEqual(["env:dev"]);
    await db.end();
  });

  it("client_policies is idempotent under repeated createAppSchema calls", async () => {
    p = await provision("appschema");
    const db = testPool({ connectionString: p.urls.admin });
    await expect(createAppSchema(db)).resolves.not.toThrow();
    await expect(createAppSchema(db)).resolves.not.toThrow();
    await db.end();
  });
});
