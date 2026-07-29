// Provisions `warehousd_e2e` from scratch: schemas, the four roles, YAML apply, synthetic
// data, indexed policies, and the three personas. Idempotent — drops and recreates.
import { Pool } from "pg";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const ADMIN = "postgres://postgres:postgres@127.0.0.1:54330/postgres";
const DB = "warehousd_e2e";

async function main() {
  const a = new Pool({ connectionString: ADMIN });
  await a.query(`drop database if exists ${DB} with (force)`);
  await a.query(`create database ${DB}`);
  await a.end();

  process.env.APP_DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:54330/${DB}`;
  process.env.DEV_DATABASE_URL = `postgres://warehousd_dev:pw@127.0.0.1:54330/${DB}`;
  process.env.LIVE_DATABASE_URL = `postgres://warehousd_live:pw@127.0.0.1:54330/${DB}`;
  process.env.IMPORT_DATABASE_URL = `postgres://warehousd_import:pw@127.0.0.1:54330/${DB}`;
  process.env.WAREHOUSD_PROJECT_DIR = resolve(__dirname, "../examples/harbor");
  process.env.WAREHOUSD_DEMO = "true";

  execSync("pnpm tsx scripts/dev-bootstrap.ts", { stdio: "inherit", env: process.env });

  // Fix: dev-bootstrap deletes accounts but doesn't recreate them for the final user IDs.
  // Recreate accounts by signing up then updating user IDs (same as web-db helper).
  const db = new Pool({ connectionString: process.env.APP_DATABASE_URL });

  // Re-import auth after dev-bootstrap has set up everything
  const { auth } = await import("../apps/web/lib/auth");

  const personas = [
    { id: "ana", email: "ana@harbor.demo", name: "Ana" },
    { id: "marcus", email: "marcus@harbor.demo", name: "Marcus" },
    { id: "mia", email: "mia@harbor.demo", name: "Mia" },
  ];

  for (const p of personas) {
    // Check if account already exists for this user
    const existing = await db.query(`select 1 from app."account" where "userId"=$1`, [p.id]);
    if (existing.rowCount === 0) {
      // Sign up with a temporary credential to create the account, then move it to the permanent user ID
      const res = await auth.api.signUpEmail({
        body: { email: `temp-${p.id}@example.com`, password: "demo", name: p.name },
      });
      const tempId = res.user.id;
      // Move the account from temp user to permanent user ID
      await db.query(`update app."account" set "userId"=$1 where "userId"=$2`, [p.id, tempId]);
      // Delete the temp user
      await db.query(`delete from app."user" where id=$1`, [tempId]);
    }
  }

  await db.end();
  console.log(`e2e database ready: ${DB}`);
}
main();
