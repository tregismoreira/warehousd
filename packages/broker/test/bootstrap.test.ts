import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";
import { provision, testPool } from "./helpers/db";
import { ensureSchemasAndRoles, dataRoleUrl } from "../src/index";

describe("bootstrap", () => {
  let db: Pool;
  let provisioned: Awaited<ReturnType<typeof provision>>;

  beforeEach(async () => {
    // Bare, not the template: this suite is what proves ensureSchemasAndRoles creates the
    // schemas and roles in the first place, so it has to start from an empty database.
    provisioned = await provision("bootstrap", { bare: true });
    db = testPool({ connectionString: provisioned.urls.admin });
  });

  afterEach(async () => {
    await db.end();
    await provisioned.end();
  });

  it("ensureSchemasAndRoles is idempotent and creates schemas/roles", async () => {
    // First call
    await ensureSchemasAndRoles(db, "pw");

    // Verify schemas exist
    const schemas = await db.query(
      `select schema_name from information_schema.schemata where schema_name in ('app', 'data_synth', 'data_live')`,
    );
    expect(schemas.rowCount).toBe(3);

    // Verify roles exist
    const roles = await db.query(
      `select rolname from pg_roles where rolname in ('warehousd_dev', 'warehousd_live')`,
    );
    expect(roles.rowCount).toBe(2);

    // Second call should succeed (idempotent)
    await ensureSchemasAndRoles(db, "pw");

    // Schemas/roles still exist
    const schemas2 = await db.query(
      `select schema_name from information_schema.schemata where schema_name in ('app', 'data_synth', 'data_live')`,
    );
    expect(schemas2.rowCount).toBe(3);

    const roles2 = await db.query(
      `select rolname from pg_roles where rolname in ('warehousd_dev', 'warehousd_live')`,
    );
    expect(roles2.rowCount).toBe(2);
  });

  it("warehousd_dev can connect and has access to data_synth and app schemas", async () => {
    await ensureSchemasAndRoles(db, "pw");

    const devDb = testPool({
      connectionString: `postgres://warehousd_dev:pw@127.0.0.1:54330/${provisioned.dbName}`,
    });

    // Should succeed: can connect
    const check = await devDb.query(`select current_user`);
    expect(check.rows[0].current_user).toBe("warehousd_dev");

    await devDb.end();
  });

  it("password with special chars (single quote and backslash) round-trips", async () => {
    const specialPassword = "p\\w'w";
    try {
      await ensureSchemasAndRoles(db, specialPassword);

      const devDb = testPool({
        connectionString: `postgres://warehousd_dev:${encodeURIComponent(specialPassword)}@127.0.0.1:54330/${provisioned.dbName}`,
      });

      // Should be able to connect and query
      const result = await devDb.query("select 1 as ok");
      expect(result.rows[0].ok).toBe(1);

      await devDb.end();
    } finally {
      // Roles — and their passwords — are cluster-global, while the databases the rest of the
      // suite provisions are not. Leaving this rotation in place makes other suites' pools
      // fail to authenticate partway through a run, surfacing as unrelated feature tests
      // failing with "password authentication failed". Put it back.
      await ensureSchemasAndRoles(db, "pw");
    }
  });

  it("dataRoleUrl preserves host/port/database and replaces user/password", () => {
    const appUrl = "postgres://user:oldpass@localhost:5432/mydb";
    const url = dataRoleUrl(appUrl, "warehousd_dev", "newpass");
    const parsed = new URL(url);
    expect(parsed.username).toBe("warehousd_dev");
    expect(parsed.password).toBe("newpass");
    expect(parsed.hostname).toBe("localhost");
    expect(parsed.port).toBe("5432");
    expect(parsed.pathname).toBe("/mydb");
  });

  it("dataRoleUrl encodes special characters in role and password", () => {
    const appUrl = "postgres://user:oldpass@localhost:5432/mydb";
    const url = dataRoleUrl(appUrl, "role@example", "pass with spaces");
    const parsed = new URL(url);
    expect(parsed.username).toBe("role%40example");
    expect(parsed.password).toBe("pass%20with%20spaces");
  });

  // Invariant 5 lives on this. Through Supavisor the username carries the project, so a bare
  // `warehousd_dev` authenticates as nobody — and the tempting "fix" is to fall back to the owner
  // url, at which point the dev role reads data_live and the wall is gone.
  it("dataRoleUrl keeps the Supabase project ref the pooler routes on", () => {
    const appUrl =
      "postgres://postgres.abcdefghij:owner@aws-0-sa-east-1.pooler.supabase.com:5432/postgres";
    const parsed = new URL(dataRoleUrl(appUrl, "warehousd_dev", "newpass"));
    expect(parsed.username).toBe("warehousd_dev.abcdefghij");
    expect(parsed.password).toBe("newpass");
    expect(parsed.hostname).toBe("aws-0-sa-east-1.pooler.supabase.com");
  });

  it("dataRoleUrl takes an explicit provider over the host", () => {
    const appUrl = "postgres://postgres.abcdefghij:owner@pg.example.com:5432/postgres";
    expect(new URL(dataRoleUrl(appUrl, "warehousd_dev", "pw")).username).toBe("warehousd_dev");
    expect(new URL(dataRoleUrl(appUrl, "warehousd_dev", "pw", "supabase")).username).toBe(
      "warehousd_dev.abcdefghij",
    );
  });
});
