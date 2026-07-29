// Provisions the e2e database from scratch: schemas, the four roles, YAML apply, synthetic
// data, indexed policies, and the three personas. Idempotent — drops and recreates.
import { Pool } from "pg";
import { execSync } from "node:child_process";
import { basename, resolve } from "node:path";

const ADMIN = "postgres://postgres:postgres@127.0.0.1:54330/postgres";
// Sibling checkouts share one Postgres container, so a fixed database name means two
// concurrent `pnpm e2e` runs drop and recreate each other's data mid-suite. Scope the name to
// the workspace directory. `apps/web/playwright.config.ts` derives the same slug.
const SLUG = basename(resolve(__dirname, "..")).toLowerCase().replace(/[^a-z0-9_]/g, "_");
const DB = process.env.WAREHOUSD_E2E_DB ?? `warehousd_e2e_${SLUG}`;

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

  // Seed grants for E2E tests: proposal flow (write-path.spec.ts)
  const { requestGrant, approveGrant, revokeGrant, loadConfig } = await import("../packages/broker/src/index");
  const { getAppPool } = await import("../apps/web/app/lib/broker");
  const app = getAppPool();
  const cfg = loadConfig(process.env.WAREHOUSD_PROJECT_DIR!);

  const fields = ["id", "title", "notes", "assignee", "created_at"];

  // dev-bootstrap derives Marcus's and Ana's grants from the config, so they already hold an
  // approved grant on every collection — matter_tasks included. `grants_one_active` permits one
  // approved grant per (org, user, collection, env), and these specs need a particular shape
  // (Marcus direct with approve, Mia proposal_only), so retire whatever the demo seed left on
  // the tuples below instead of colliding with it. Revoked rather than deleted: the status
  // transition is the model's own, and the specs read the grant history.
  async function retireApproved(userId: string, collection: string, env: string) {
    const { rows } = await app.query(
      `select id from app.grants
        where org_id='default' and user_id=$1 and collection=$2 and env=$3 and status='approved'`,
      [userId, collection, env],
    );
    for (const r of rows) await revokeGrant(app, r.id, "e2e-setup");
  }

  // Marcus: direct-mode grant with read+create+approve on matter_tasks
  await retireApproved("marcus", "matter_tasks", "dev");
  const marcusGrant = await requestGrant(app, {
    userId: "marcus",
    collection: "matter_tasks",
    orgId: "default",
    env: "dev",
    purposeLabel: "manager",
    allowedFields: fields,
  });
  await approveGrant(app, cfg, marcusGrant, "marcus", {
    verbs: ["read", "create", "approve"],
    mode: "direct",
  });

  // Mia: proposal_only-mode grant with read+create on matter_tasks
  // Mia's demo grants do not currently cover matter_tasks, but they are seeded from the same
  // config-derived path, so guard the tuple rather than rely on that staying true.
  await retireApproved("mia", "matter_tasks", "dev");
  const miaGrant = await requestGrant(app, {
    userId: "mia",
    collection: "matter_tasks",
    orgId: "default",
    env: "dev",
    purposeLabel: "member",
    allowedFields: fields,
  });
  await approveGrant(app, cfg, miaGrant, "marcus", {
    verbs: ["read", "create"],
    mode: "proposal_only",
  });

  await db.end();
  console.log(`e2e database ready: ${DB}`);
}
main();
