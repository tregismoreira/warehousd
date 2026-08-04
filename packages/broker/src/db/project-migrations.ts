import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A different advisory-lock key from migrateApp's. The two run back to back on the same boot and
// must not be able to serialise against each other by accident.
const LOCK_KEY = 87220002;

export type ProjectMigration = { version: string; sql: string; checksum: string };

/**
 * The migration files in `<project>/migrations/`, in application order.
 *
 * A directory scan is right here, where the static array in `db/migrations/index.ts` would be
 * wrong: these files are project data read from disk at runtime, exactly like `warehousd.yml` and
 * a collection's `source` directory. Nothing bundles them into the JS, so there is no build step
 * whose view of them could disagree with the runtime's.
 */
export function readProjectMigrations(projectDir: string): ProjectMigration[] {
  const dir = join(projectDir, "migrations");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => {
      const sql = readFileSync(join(dir, f), "utf8");
      return {
        version: f.replace(/\.sql$/, ""),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    });
}

/**
 * Apply the project's pending migrations. Returns the versions applied by THIS call — an empty
 * array means there was nothing to do.
 *
 * Same shape as `migrateApp`: one dedicated client because advisory locks are session-scoped, and
 * each migration in its own transaction so a failure rolls that one back and leaves the ledger
 * consistent for a retry on the next boot. That matters for the same reason it does there — a
 * failed migration aborts the release and the previous version keeps serving, so the database has
 * to stay in a state the old code can use.
 */
export async function runProjectMigrations(db: Pool, projectDir: string): Promise<string[]> {
  const migrations = readProjectMigrations(projectDir);
  if (migrations.length === 0) return [];

  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query(`select pg_advisory_lock($1)`, [LOCK_KEY]);

    const { rows } = await client.query<{ version: string; checksum: string }>(
      `select version, checksum from app.collection_migrations`,
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const { version, sql, checksum } of migrations) {
      const seen = done.get(version);
      if (seen !== undefined) {
        // Editing a migration that already ran changes nothing in the database and everything in
        // what the file claims happened. Refuse rather than skip: a silent skip is how the file on
        // disk and the schema in production quietly stop describing each other.
        if (seen !== checksum)
          throw new Error(
            `migration ${version} was already applied but its file has changed since. ` +
              `Restore it, or add a new migration — an applied migration is history, not a draft.`,
          );
        continue;
      }
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          `insert into app.collection_migrations (version, checksum) values ($1,$2)
           on conflict (version) do nothing`,
          [version, checksum],
        );
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        // The operator wrote this SQL, and the message is the only way they learn which statement
        // blocked the boot. Same call migrateApp makes, for the same reason: nothing from here
        // reaches a broker caller.
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

export type ProjectMigrationStatus = {
  version: string;
  state: "applied" | "pending" | "modified";
};

/** What `warehousd migrate status` prints. */
export async function projectMigrationStatus(
  db: Pool,
  projectDir: string,
): Promise<ProjectMigrationStatus[]> {
  const { rows } = await db.query<{ version: string; checksum: string }>(
    `select version, checksum from app.collection_migrations`,
  );
  const done = new Map(rows.map((r) => [r.version, r.checksum]));
  return readProjectMigrations(projectDir).map(({ version, checksum }) => {
    const seen = done.get(version);
    if (seen === undefined) return { version, state: "pending" as const };
    return { version, state: seen === checksum ? ("applied" as const) : ("modified" as const) };
  });
}
