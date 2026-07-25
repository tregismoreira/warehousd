import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { provision } from "./helpers/db";
import { ensureSchemasAndRoles, dataRoleUrl, getClientPolicy, ensureDevClient } from "../src/index";

describe("bootstrap", () => {
  let db: Pool;
  let provisioned: Awaited<ReturnType<typeof provision>>;

  beforeEach(async () => {
    provisioned = await provision("bootstrap");
    db = new Pool({ connectionString: provisioned.urls.admin });
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
      `select schema_name from information_schema.schemata where schema_name in ('app', 'data_synth', 'data_live')`
    );
    expect(schemas.rowCount).toBe(3);

    // Verify roles exist
    const roles = await db.query(
      `select rolname from pg_roles where rolname in ('warehousd_dev', 'warehousd_live')`
    );
    expect(roles.rowCount).toBe(2);

    // Second call should succeed (idempotent)
    await ensureSchemasAndRoles(db, "pw");

    // Schemas/roles still exist
    const schemas2 = await db.query(
      `select schema_name from information_schema.schemata where schema_name in ('app', 'data_synth', 'data_live')`
    );
    expect(schemas2.rowCount).toBe(3);

    const roles2 = await db.query(
      `select rolname from pg_roles where rolname in ('warehousd_dev', 'warehousd_live')`
    );
    expect(roles2.rowCount).toBe(2);
  });

  it("warehousd_dev can connect and has access to data_synth and app schemas", async () => {
    await ensureSchemasAndRoles(db, "pw");

    const devDb = new Pool({
      connectionString: `postgres://warehousd_dev:pw@127.0.0.1:54330/${provisioned.dbName}`,
    });

    // Should succeed: can connect
    const check = await devDb.query(`select current_user`);
    expect(check.rows[0].current_user).toBe("warehousd_dev");

    await devDb.end();
  });

  it("password with special chars (single quote and backslash) round-trips", async () => {
    const specialPassword = "p\\w'w";
    await ensureSchemasAndRoles(db, specialPassword);

    const devDb = new Pool({
      connectionString: `postgres://warehousd_dev:${encodeURIComponent(specialPassword)}@127.0.0.1:54330/${provisioned.dbName}`,
    });

    // Should be able to connect and query
    const result = await devDb.query("select 1 as ok");
    expect(result.rows[0].ok).toBe(1);

    await devDb.end();
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
});
