import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "../../broker/test/helpers/db";
import { ADMIN } from "../../broker/test/helpers/templates";
import { databaseCapabilities, searchPathBlocked } from "../src/deploy/database-checks";

// Every check here answers a question that would otherwise be answered by a failed release, after
// the image is built and pushed. They are read-only on purpose: they ask the catalogue what is
// possible, they never create a role or an extension to find out.

const byId = (checks: { id: string; ok: boolean; detail: string }[], id: string) =>
  checks.find((c) => c.id === id);

describe("databaseCapabilities against a database this role owns", () => {
  let p: Provisioned;
  beforeAll(async () => {
    p = await provision("cli-dbcaps");
  }, 60_000);
  afterAll(async () => {
    await p?.end();
  });

  it("passes every check", async () => {
    const checks = await databaseCapabilities(p.urls.admin, { requireFdw: false });
    expect(checks.map((c) => c.id)).toEqual([
      "db-reachable",
      "db-can-create-role",
      "db-extensions",
      "db-search-path",
      "db-provider",
    ]);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("names the host but never the password", async () => {
    const reachable = byId(
      await databaseCapabilities(p.urls.admin, { requireFdw: false }),
      "db-reachable",
    );
    expect(reachable?.detail).toContain("127.0.0.1:54330");
    expect(reachable?.detail).not.toContain("postgres:postgres");
  });

  // postgres_fdw is only created when the config declares a `sources:` entry, because neither
  // Supabase nor Neon allows it — demanding it unconditionally would refuse a deployment over a
  // feature it does not use.
  it("only demands postgres_fdw when a source is configured", async () => {
    const without = byId(
      await databaseCapabilities(p.urls.admin, { requireFdw: false }),
      "db-extensions",
    );
    expect(without?.detail).not.toContain("postgres_fdw");
    const with_ = byId(
      await databaseCapabilities(p.urls.admin, { requireFdw: true }),
      "db-extensions",
    );
    expect(with_?.detail).toContain("postgres_fdw");
  });

  it("an explicit provider overrides host detection in the db-provider line", async () => {
    const generic = byId(
      await databaseCapabilities(p.urls.admin, { requireFdw: false }),
      "db-provider",
    );
    expect(generic?.detail).toContain("Generic Postgres");
    const supabase = byId(
      await databaseCapabilities(p.urls.admin, { requireFdw: false, provider: "supabase" }),
      "db-provider",
    );
    expect(supabase?.ok).toBe(true);
    expect(supabase?.detail).toContain("Supabase");
  });
});

// Supabase's `extensions` schema belongs to `postgres`, and a project connecting as anything else
// cannot grant usage on it — which is exactly what ensureExtensionSearchPath must do at apply
// time. Reproduced here with a schema the connecting role does not own.
describe("databaseCapabilities as a role that owns nothing", () => {
  let p: Provisioned;
  beforeAll(async () => {
    p = await provision("cli-dbcaps-unpriv", { bare: true });
    const admin = new Pool({ connectionString: p.urls.admin, max: 1 });
    await admin.query(`
      create schema extensions;
      create extension pgcrypto with schema extensions;
    `);
    await admin.end();
  }, 60_000);
  afterAll(async () => {
    await p?.end();
  });

  it("refuses on the role privilege and on the unreachable extension schema", async () => {
    const checks = await databaseCapabilities(p.urls.dev, { requireFdw: false });
    expect(byId(checks, "db-reachable")?.ok).toBe(true);

    const role = byId(checks, "db-can-create-role");
    expect(role?.ok).toBe(false);
    expect(role?.detail).toContain("CREATEROLE");

    const path = byId(checks, "db-search-path");
    expect(path?.ok).toBe(false);
    expect(path?.detail).toContain("pgcrypto");
    expect(path?.detail).toContain("extensions");
  });
});

// Usage held by PUBLIC is held by every role, including the four boot has yet to create. The check
// used to look only at the roles that exist right now — none of which hold usage explicitly — and
// refuse a schema that was reachable all along. Its own fixture rather than a grant on the one
// above, which the refusal there depends on not having.
describe("databaseCapabilities against a schema PUBLIC can reach", () => {
  let p: Provisioned;
  beforeAll(async () => {
    p = await provision("cli-dbcaps-public", { bare: true });
    const admin = new Pool({ connectionString: p.urls.admin, max: 1 });
    await admin.query(`
      create schema extensions;
      create extension pgcrypto with schema extensions;
      grant usage on schema extensions to public;
    `);
    await admin.end();
  }, 60_000);
  afterAll(async () => {
    await p?.end();
  });

  it("accepts the schema without owning it, and still refuses the role privilege", async () => {
    const checks = await databaseCapabilities(p.urls.dev, { requireFdw: false });
    expect(byId(checks, "db-search-path")?.ok).toBe(true);
    // Unchanged: this is the capability answer about a schema, not a privilege the role gained.
    expect(byId(checks, "db-can-create-role")?.ok).toBe(false);
  });
});

/**
 * The first-deploy branch, which no database on this cluster can reproduce.
 *
 * `pg_roles` is cluster-global and every suite in this repo shares one Postgres, so `warehousd_*`
 * roles exist by the time any test runs — `role_count` is never 0 here, and a real first deploy
 * against a fresh Neon or Supabase project is the only place it is. Hence the predicate is tested
 * directly rather than through a fixture that cannot hold the condition.
 */
describe("searchPathBlocked", () => {
  const row = { can_grant: false, public_usage: false, role_count: "0", lacking: "0" };

  it("refuses a first deploy: nothing owns it, PUBLIC cannot reach it, no role has proved it", () => {
    expect(searchPathBlocked(row)).toBe(true);
  });

  it("accepts when this role owns the schema, or when PUBLIC already holds usage", () => {
    expect(searchPathBlocked({ ...row, can_grant: true })).toBe(false);
    expect(searchPathBlocked({ ...row, public_usage: true })).toBe(false);
  });

  // The post-boot case: the roles exist and every one of them already reaches the schema.
  it("accepts once the roles exist and none of them lacks usage", () => {
    expect(searchPathBlocked({ ...row, role_count: "4", lacking: "0" })).toBe(false);
    expect(searchPathBlocked({ ...row, role_count: "4", lacking: "1" })).toBe(true);
  });
});

/**
 * Neon's `neondb_owner` has neither CREATEROLE nor SUPERUSER of its own — it gets CREATEROLE
 * through membership in `neon_superuser`. RDS is the same shape with `rds_superuser`. Reading the
 * connecting role's own attributes refused every correctly configured deployment on both.
 *
 * The two roles are named off the database, which already carries this checkout's suffix: roles
 * are cluster-global and a bare `wh_creator` would collide with a sibling checkout's run.
 */
describe("databaseCapabilities as a role that inherits CREATEROLE", () => {
  let p: Provisioned;
  let member = "";
  let grantor = "";

  beforeAll(async () => {
    p = await provision("cli-dbcaps-inherit", { bare: true });
    member = `${p.dbName}_member`;
    grantor = `${p.dbName}_creator`;
    const admin = new Pool({ connectionString: p.urls.admin, max: 1 });
    await admin.query(`create role ${grantor} createrole`);
    await admin.query(`create role ${member} login password 'pw'`);
    await admin.query(`grant ${grantor} to ${member}`);
    await admin.query(`grant connect on database ${p.dbName} to ${member}`);
    await admin.end();
  }, 60_000);

  // The database goes first: Postgres refuses to drop a role that still holds a privilege on one.
  afterAll(async () => {
    await p?.end();
    if (!member) return;
    const admin = new Pool({ connectionString: ADMIN, max: 1 });
    await admin.query(`drop role if exists ${member}`);
    await admin.query(`drop role if exists ${grantor}`);
    await admin.end();
  });

  it("accepts CREATEROLE held through an inheritable membership", async () => {
    const url = `postgres://${member}:pw@127.0.0.1:54330/${p.dbName}`;
    const role = byId(await databaseCapabilities(url, { requireFdw: false }), "db-can-create-role");
    expect(role?.ok).toBe(true);
    expect(role?.detail).toContain(member);
  });
});

// `provider` is an override for a host that does not advertise who runs it — a CNAME, a proxy.
// Set against a host that says otherwise it is a role that cannot authenticate, which is the one
// failure the key exists to prevent (docs/deploy-database.md).
describe("an explicit provider that contradicts the host", () => {
  it("refuses, naming both, and never runs the configured provider's own checks", async () => {
    const checks = await databaseCapabilities(
      "postgres://u:p@ep-cool-1.eu-central-1.aws.neon.tech:5432/neondb",
      { requireFdw: false, provider: "supabase" },
    );
    const provider = byId(checks, "db-provider");
    expect(provider?.ok).toBe(false);
    expect(provider?.detail).toContain("Supabase");
    expect(provider?.detail).toContain("Neon");
    expect(checks.filter((c) => c.id === "db-provider")).toHaveLength(1);
  });

  it("leaves a configured provider over an unrecognised host alone — the CNAME case", async () => {
    const provider = byId(
      await databaseCapabilities("postgres://postgres.abcdefghij:pw@pg.example.com:5432/postgres", {
        requireFdw: false,
        provider: "supabase",
      }),
      "db-provider",
    );
    expect(provider?.ok).toBe(true);
    expect(provider?.detail).toContain("Supabase");
  });
});

// A database that cannot be reached is not evidence that it can do any of this. Refuse, and say
// it was the lookup that failed — the rule ssoOrLocalLoginCheck already follows.
describe("databaseCapabilities when the database is unreachable", () => {
  it("refuses db-reachable and evaluates nothing that needs a connection", async () => {
    const checks = await databaseCapabilities("postgres://nobody:nothing@127.0.0.1:1/absent", {
      requireFdw: false,
    });
    expect(byId(checks, "db-reachable")?.ok).toBe(false);
    for (const id of ["db-can-create-role", "db-extensions", "db-search-path"]) {
      expect(byId(checks, id)?.ok).toBe(false);
      expect(byId(checks, id)?.detail).toContain("not evaluated");
    }
  });

  // The provider's own finding does not need a connection, and is a plausible reason the
  // connection behaved oddly in the first place. Local host and a forced provider so this stays
  // an offline test — nothing here dials Supabase.
  it("still reports the Supabase transaction pooler", async () => {
    const checks = await databaseCapabilities(
      "postgres://postgres.abcdefghij:pw@127.0.0.1:6543/postgres",
      {
        requireFdw: false,
        provider: "supabase",
      },
    );
    expect(byId(checks, "db-reachable")?.ok).toBe(false);
    const provider = byId(checks, "db-provider");
    expect(provider?.ok).toBe(false);
    expect(provider?.detail).toContain("6543");
  });
});
