import type { Pool, PoolClient } from "pg";

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
      // Check if role exists using parameterized query
      const existing = await client.query(
        `select 1 from pg_roles where rolname = $1`,
        [role]
      );

      const escapedPassword = client.escapeLiteral(dataRolePassword);

      if (existing.rowCount === 0) {
        // Create new role
        await client.query(
          `create role ${role} login password ${escapedPassword}`
        );
      } else {
        // Rotate password on existing role
        await client.query(
          `alter role ${role} password ${escapedPassword}`
        );
      }
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
