import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { migrateApp } from "../src/db/migrate";
import { MIGRATIONS } from "../src/db/migrations";
import { createAppSchema } from "../src/db/migrate-app";

// noUncheckedIndexedAccess is on, so an index read is `Migration | undefined`.
function migrationAt(i: number) {
  const m = MIGRATIONS[i];
  if (!m) throw new Error(`no migration at index ${i}`);
  return m;
}

let p: Provisioned, db: Pool;
beforeAll(async () => {
  p = await provision("migrate");
  db = new Pool({ connectionString: p.urls.admin });
});
afterAll(async () => {
  await db?.end();
  await p?.end();
});

describe("migrateApp", () => {
  it("applies every migration on a fresh database and records each version", async () => {
    const applied = await migrateApp(db);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.version));

    const { rows } = await db.query<{ version: string }>(
      `select version from app.schema_migrations order by version`,
    );
    expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));

    const tables = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema='app'`,
    );
    const names = tables.rows.map((r) => r.table_name);
    for (const t of [
      "workspaces",
      "collections",
      "grants",
      "audit_events",
      "vocabularies",
      "terms",
      "client_policies",
      "client_secrets",
      "trusted_issuers",
      "change_log",
    ])
      expect(names, `app.${t} missing`).toContain(t);
  });

  it("is a no-op on the second call", async () => {
    expect(await migrateApp(db)).toEqual([]);
  });

  it("preserves grants and audit rows across a re-run", async () => {
    await db.query(
      `insert into app.grants (user_id, collection, allowed_fields, env, status)
       values ('keeper', 'people', array['id'], 'dev', 'approved')`,
    );
    await db.query(
      `insert into app.audit_events (user_id, env, collection, outcome)
       values ('keeper', 'dev', 'people', 'allowed')`,
    );

    await migrateApp(db);

    const g = await db.query<{ c: number }>(
      `select count(*)::int c from app.grants where user_id='keeper'`,
    );
    const a = await db.query<{ c: number }>(
      `select count(*)::int c from app.audit_events where user_id='keeper'`,
    );
    expect(g.rows[0]?.c).toBe(1);
    expect(a.rows[0]?.c).toBe(1);
  });

  // The grant/revoke block at the end of 0001 is the enforcement mechanism for invariant 7
  // (docs/architecture.md). A migration that dropped it would still create every table, so
  // nothing else in this file would notice.
  it("keeps audit_events INSERT-only for the data roles", async () => {
    const { rows } = await db.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.table_privileges
       where table_schema='app' and table_name='audit_events' and grantee='warehousd_dev'`,
    );
    const privs = rows.map((r) => r.privilege_type);
    expect(privs).toContain("INSERT");
    expect(privs).not.toContain("UPDATE");
    expect(privs).not.toContain("DELETE");
  });

  it("upgrades a database built by the pre-ledger createAppSchema", async () => {
    // The case this task exists for: a deploy provisioned by the old function, carrying no
    // ledger and holding grants that have to survive adopting one.
    const legacy = await provision("migrate-legacy");
    const ldb = new Pool({ connectionString: legacy.urls.admin });
    try {
      await ldb.query(migrationAt(0).sql);
      await ldb.query(
        `insert into app.grants (user_id, collection, allowed_fields, env, status)
         values ('legacy', 'people', array['id'], 'dev', 'approved')`,
      );

      const applied = await migrateApp(ldb);
      expect(applied).toEqual(MIGRATIONS.map((m) => m.version));

      const g = await ldb.query<{ c: number }>(
        `select count(*)::int c from app.grants where user_id='legacy'`,
      );
      expect(g.rows[0]?.c).toBe(1);
    } finally {
      await ldb.end();
      await legacy.end();
    }
  });

  it("createAppSchema remains a working alias", async () => {
    const fresh = await provision("migrate-alias");
    const fdb = new Pool({ connectionString: fresh.urls.admin });
    try {
      await expect(createAppSchema(fdb)).resolves.not.toThrow();
      const { rows } = await fdb.query(`select version from app.schema_migrations`);
      expect(rows.length).toBe(MIGRATIONS.length);
    } finally {
      await fdb.end();
      await fresh.end();
    }
  });
});

// The per-migration transaction is the reason a failed release is survivable: the Fly release
// command runs migrateApp, and a failure there aborts the deploy while the previous release keeps
// serving. That only holds if the database is left in a state the old code can still use — so a
// half-applied migration must roll back, and must not be recorded as done.
describe("migrateApp, when a migration fails", () => {
  let p2: Provisioned, db2: Pool;
  beforeAll(async () => {
    p2 = await provision("migrate-fail");
    db2 = new Pool({ connectionString: p2.urls.admin });
  });
  afterAll(async () => {
    vi.doUnmock("../src/db/migrations");
    vi.resetModules();
    await db2?.end();
    await p2?.end();
  });

  it("rolls the migration back, names it in the error, and records nothing", async () => {
    vi.resetModules();
    vi.doMock("../src/db/migrations", () => ({
      // Creates a table, then divides by zero. If the transaction is missing, the table survives.
      MIGRATIONS: [
        { version: "9999_bad", sql: `create table app.half_applied (id int); select 1 / 0;` },
      ],
    }));
    try {
      const { migrateApp: failing } = await import("../src/db/migrate");

      await expect(failing(db2)).rejects.toThrow(/migration 9999_bad failed/);

      const table = await db2.query<{ n: string | null }>(
        `select to_regclass('app.half_applied')::text n`,
      );
      expect(table.rows[0]?.n, "the failed migration's table survived the rollback").toBeNull();

      const ledger = await db2.query(`select version from app.schema_migrations`);
      expect(ledger.rows.length, "a failed migration was recorded as applied").toBe(0);
    } finally {
      vi.doUnmock("../src/db/migrations");
      vi.resetModules();
    }
  });

  // A failure must not leave the advisory lock held, or the next boot blocks forever instead of
  // reporting the error again.
  //
  // Asserted by taking the lock from a fresh connection rather than by counting rows in pg_locks:
  // advisory locks are cluster-global and the parallel pass has neighbours holding their own (the
  // template clone lock is one), so a count measures the whole server and passes or fails on who
  // else is running. Acquiring it is also the property that actually matters.
  it("releases the advisory lock so the next attempt can run", async () => {
    const other = new Pool({ connectionString: p2.urls.admin, max: 1 });
    try {
      const got = await other.query<{ locked: boolean }>(
        `select pg_try_advisory_lock(87220001) as locked`,
      );
      expect(got.rows[0]?.locked, "the failed run left its advisory lock held").toBe(true);
      await other.query(`select pg_advisory_unlock(87220001)`);
    } finally {
      await other.end();
    }
  });
});
