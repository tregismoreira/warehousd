import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision } from "../../../packages/broker/test/helpers/db";
import { bootstrapWebDb, PERSONAS } from "./helpers/web-db";

// Every other web suite clones a template that globalSetup built once, so nothing else in the
// run drives the bootstrap against an empty database any more. This does — same
// bootstrapWebDb the template is built from, so the two cannot drift — and is what keeps the
// container entrypoint's schema/role/migration path covered.
describe("web bootstrap against a virgin database", () => {
  let provisioned: Awaited<ReturnType<typeof provision>>;
  let db: Pool;

  beforeAll(async () => {
    provisioned = await provision("entrypoint-bootstrap", { bare: true });
    await bootstrapWebDb(provisioned.urls.admin);
    db = new Pool({ connectionString: provisioned.urls.admin, max: 2 });
  }, 120_000);

  afterAll(async () => {
    // Guarded: if beforeAll fails, an unguarded teardown throws over the top of it and the
    // real cause is the second error in the report rather than the first.
    await db?.end();
    await provisioned?.end();
  });

  it("creates the schemas and the data roles", async () => {
    const schemas = await db.query(
      `select schema_name from information_schema.schemata where schema_name in ('app', 'data_synth', 'data_live')`,
    );
    expect(schemas.rowCount).toBe(3);

    const roles = await db.query(
      `select rolname from pg_roles where rolname in
        ('warehousd_dev', 'warehousd_live', 'warehousd_import', 'warehousd_dev_write', 'warehousd_live_write')`,
    );
    expect(roles.rowCount).toBe(5);
  });

  it("creates the app schema alongside the Better Auth tables", async () => {
    const tables = await db.query(
      `select table_name from information_schema.tables where table_schema = 'app'`,
    );
    const names = tables.rows.map((r) => r.table_name);
    for (const t of ["organizations", "collections", "grants", "audit_events", "client_policies"]) {
      expect(names).toContain(t);
    }
    for (const t of ["user", "session", "account"]) {
      expect(names).toContain(t);
    }
  });

  it("migrateUserOrg puts the org default on user.orgId", async () => {
    const col = await db.query(
      `select column_default from information_schema.columns
       where table_schema = 'app' and table_name = 'user' and column_name = 'orgId'`,
    );
    expect(col.rows[0]?.column_default).toContain("default");

    const fk = await db.query(`select 1 from pg_constraint where conname = 'user_org_fk'`);
    expect(fk.rowCount).toBe(1);
  });

  it("seeds the personas with their fixed ids and roles", async () => {
    const users = await db.query(`select id, email, role, "orgId" from app."user" order by id`);
    expect(users.rows).toEqual(
      [...PERSONAS]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((p) => ({ id: p.id, email: p.email, role: p.role, orgId: "default" })),
    );
  });
});
