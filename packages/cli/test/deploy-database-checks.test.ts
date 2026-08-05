import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "../../broker/test/helpers/db";
import { databaseCapabilities } from "../src/deploy/database-checks";

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
