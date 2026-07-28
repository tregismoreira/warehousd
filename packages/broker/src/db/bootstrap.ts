import type { Pool, PoolClient } from "pg";

// Roles are cluster-global while databases are not, so two bootstraps running against
// different databases on one cluster contend on the same pg_authid row and one of them fails
// with "tuple concurrently updated" (XX000). An advisory lock cannot fix this: advisory locks
// are DATABASE-scoped, so two connections to different databases never see each other's.
// Retrying is what actually works — the conflict is transient by definition, since the loser
// only has to wait for the winner's catalogue update to land.
async function withRoleRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (attempt >= 5 || !/tuple concurrently updated/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
}

export async function ensureSchemasAndRoles(db: Pool, dataRolePassword: string): Promise<void> {
  // Create schemas
  await db.query(`
    create schema if not exists app;
    create schema if not exists data_synth;
    create schema if not exists data_live;
  `);

  // Create or rotate roles. We use a parameterized select to check role existence,
  // then build CREATE/ALTER statements with escapeLiteral to safely quote the password.
  const client = await db.connect();
  try {
    for (const role of ["warehousd_dev", "warehousd_live", "warehousd_dev_write", "warehousd_live_write"]) {
      const escapedPassword = client.escapeLiteral(dataRolePassword);
      await withRoleRetry(async () => {
        // Re-read existence inside the retry: a concurrent bootstrap may have created the
        // role between our check and our write.
        const existing = await client.query(`select 1 from pg_roles where rolname = $1`, [role]);
        if (existing.rowCount === 0) {
          await client.query(`create role ${role} login password ${escapedPassword}`);
        } else {
          await client.query(`alter role ${role} password ${escapedPassword}`);
        }
      });
    }
  } finally {
    client.release();
  }

  // Grant schema usage
  await db.query(`
    grant usage on schema data_synth to warehousd_dev;
    grant usage on schema data_live to warehousd_live;
    grant usage on schema app to warehousd_dev, warehousd_live;
    grant usage on schema data_synth to warehousd_dev_write;
    grant usage on schema data_live to warehousd_live_write;
    grant usage on schema app to warehousd_dev_write, warehousd_live_write;
  `);
}

export function dataRoleUrl(appUrl: string, role: string, password: string): string {
  const u = new URL(appUrl);
  u.username = encodeURIComponent(role);
  u.password = encodeURIComponent(password);
  return u.toString();
}
