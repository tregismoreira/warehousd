import type { Pool } from "pg";
import { MIGRATIONS } from "./migrations";

// Fixed advisory-lock key. The container entrypoint is the Fly release command, and a rolling
// deploy or `docker compose up --scale` can start two of them against one database; without this
// both would try to apply the same migration and the loser would fail on a half-applied one.
const LOCK_KEY = 87220001;

/**
 * Bring the `app` schema up to date. Returns the versions applied by THIS call — an empty array
 * means the database was already current.
 *
 * Each migration runs in its own transaction, so a failure rolls that migration back and leaves
 * the ledger consistent: a corrected migration can be retried on the next boot rather than
 * needing the database repaired by hand. That matters because a failed migration aborts the Fly
 * release and the previous release keeps serving — the database has to still be in a state the
 * old code can use.
 */
export async function migrateApp(db: Pool): Promise<string[]> {
  await db.query(`create schema if not exists app`);
  await db.query(`
    create table if not exists app.schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now())`);

  // One dedicated client: pg advisory locks are session-scoped, so the lock and the migrations
  // have to run on the same connection. db.query() would pick arbitrary members of the pool.
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query(`select pg_advisory_lock($1)`, [LOCK_KEY]);

    const { rows } = await client.query<{ version: string }>(
      `select version from app.schema_migrations`,
    );
    const done = new Set(rows.map((r) => r.version));

    for (const { version, sql } of MIGRATIONS) {
      if (done.has(version)) continue;
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          `insert into app.schema_migrations (version) values ($1)
           on conflict (version) do nothing`,
          [version],
        );
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        // Migration SQL is ours, not client input, so the message is safe to surface here — and
        // it is the only way an operator learns which migration blocked the boot. The rule this
        // does not break: nothing from here reaches a broker caller.
        throw new Error(
          `migration ${version} failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      applied.push(version);
    }
  } finally {
    await client.query(`select pg_advisory_unlock($1)`, [LOCK_KEY]);
    client.release();
  }
  return applied;
}
