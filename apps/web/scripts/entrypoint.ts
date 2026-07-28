import { Pool } from "pg";
import { execFileSync } from "child_process";
import { resolve } from "path";
import {
  ensureSchemasAndRoles,
  createAppSchema,
  migrateUserOrg,
  loadConfig,
  applyConfig,
  generateSynthetic,
  indexCollection,
  ensureDevClient,
  dataRoleUrl,
  grantableFields,
} from "@warehousd/broker";
import { auth } from "../lib/auth.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// Wait for Postgres to be ready, retrying for the given timeout
async function waitForPostgres(appUrl: string, timeoutMs: number): Promise<Pool> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const db = new Pool({ connectionString: appUrl });
      await db.query("select 1");
      await db.end();
      return new Pool({ connectionString: appUrl });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Timeout waiting for Postgres after ${timeoutMs}ms`);
}

// Create admin user if it doesn't exist
async function ensureAdminUser(db: Pool): Promise<string> {
  const adminEmail = requireEnv("WAREHOUSD_ADMIN_EMAIL");
  const adminPassword = requireEnv("WAREHOUSD_ADMIN_PASSWORD");

  // Check if admin already exists
  const existing = await db.query(`select id from app."user" where email = $1`, [adminEmail]);
  if (existing.rowCount && existing.rowCount > 0) {
    return existing.rows[0].id;
  }

  // Sign up via Better Auth
  const res = await auth.api.signUpEmail({
    body: { email: adminEmail, password: adminPassword, name: "Admin" },
  });
  const userId = res.user.id;

  // Update role to admin
  await db.query(`update app."user" set role = $1 where id = $2`, ["admin", userId]);

  return userId;
}

// Seed demo personas (ana/marcus/mia with appropriate roles and grants)
async function seedDemoPersonas(db: Pool, cfg: any): Promise<void> {
  const personas = [
    { id: "ana", email: "ana@demo.local", name: "Ana", role: "admin" },
    { id: "marcus", email: "marcus@demo.local", name: "Marcus", role: "manager" },
    { id: "mia", email: "mia@demo.local", name: "Mia", role: "member" },
  ];

  // Check if personas already exist to guard against duplicates on re-run
  const existing = await db.query(`select 1 from app."user" where id = 'ana'`);
  if (existing.rowCount && existing.rowCount > 0) {
    return; // Already seeded
  }

  // Create personas
  for (const p of personas) {
    const res = await auth.api.signUpEmail({
      body: { email: p.email, password: "demo", name: p.name },
    });
    const generatedId = res.user.id;

    // account.userId has an ON DELETE CASCADE (not ON UPDATE) FK to user.id, so renaming
    // user.id to the fixed slug requires the referencing account row to be gone first.
    // Preserve its password hash and reinsert it under the new id afterward, rather than
    // discarding it — deleting outright leaves the persona with no working credential and
    // "demo login works" (this file's whole point) silently never works again.
    const account = await db.query(
      `select * from app."account" where "userId" = $1 and "providerId" = 'credential'`,
      [generatedId]
    );
    await db.query(`delete from app."session" where "userId" = $1`, [generatedId]);
    await db.query(`delete from app."account" where "userId" = $1`, [generatedId]);
    await db.query(`update app."user" set id = $1, role = $2 where id = $3`, [
      p.id,
      p.role,
      generatedId,
    ]);
    if (account.rowCount && account.rowCount > 0) {
      const a = account.rows[0];
      await db.query(
        `insert into app."account"
           ("id","accountId","providerId","userId","password","createdAt","updatedAt")
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [a.id, a.accountId, a.providerId, p.id, a.password, a.createdAt, a.updatedAt]
      );
    }
  }

  // Create grants for ana and marcus (they see everything)
  for (const user of ["ana", "marcus"]) {
    const existing = await db.query(
      `select 1 from app.grants where user_id = $1 limit 1`,
      [user]
    );
    if (existing.rowCount === 0) {
      for (const [collName, coll] of Object.entries(cfg.collections)) {
        if (coll.type === "file") continue; // File collections are indexed, not granted like data
        const fields = grantableFields(cfg, collName);
        if (fields.length > 0) {
          await db.query(
            `insert into app.grants (user_id, collection, allowed_fields, env, status)
             values ($1, $2, $3, 'dev', 'approved')`,
            [user, collName, fields]
          );
        }
      }
    }
  }
  // Mia gets no grants initially, so the request→approve flow is demonstrable
}

export async function bootstrap(): Promise<void> {
  const appUrl = requireEnv("APP_DATABASE_URL");
  const dir = requireEnv("WAREHOUSD_PROJECT_DIR");
  const rolePw = requireEnv("WAREHOUSD_DATA_ROLE_PASSWORD");

  // 1. Postgres may still be starting: wait for up to 60s
  const db = await waitForPostgres(appUrl, 60_000);

  try {
    // 2. Schemas + data roles. Must precede createAppSchema, which grants to those roles.
    await ensureSchemasAndRoles(db, rolePw);

    // 3. app.* tables. MUST run before the Better Auth migration
    await createAppSchema(db);

    // 4. Better Auth's own tables (user/session/account/verification/oauthApplication).
    //    Skip if WAREHOUSD_SKIP_BA_MIGRATE is set (for testing, since cwd:/app doesn't exist on host).
    //    Run from the web package directory to resolve better-auth CLI for offline operation.
    if (process.env.WAREHOUSD_SKIP_BA_MIGRATE !== "true") {
      execFileSync("pnpm", ["exec", "better-auth", "migrate", "--config", "lib/auth.ts", "-y"], {
        cwd: "/app/apps/web",
        stdio: "inherit",
        env: process.env,
      });
    }

    // 4b. Push the org default down onto Better Auth's generated `user.orgId` column.
    //     Must follow step 4 — the table does not exist before it.
    await migrateUserOrg(db);

    // 5. YAML → data_synth/data_live tables + views + app.collections. Idempotent by design.
    const cfg = loadConfig(dir);
    await applyConfig(db, cfg);

    // 6. First admin. After the Better Auth migration and after applyConfig
    const adminId = await ensureAdminUser(db);

    // 7. Demo personas — only when opted in
    if (process.env.WAREHOUSD_DEMO === "true" || cfg.demo) {
      await seedDemoPersonas(db, cfg);
    }

    // 8. Synthetic data. Truncate-then-generate so a restart is idempotent
    for (const [name, c] of Object.entries(cfg.collections)) {
      if (c.type === "file") continue; // file collections are indexed, not generated
      await db.query(`truncate data_synth.${name} cascade`);
    }
    await generateSynthetic(db, cfg, Number(process.env.WAREHOUSD_SEED ?? 42));

    // 9. Index file collections
    for (const [name, c] of Object.entries(cfg.collections)) {
      if (c.type !== "file") continue;
      const taxonomy = c.taxonomy
        ? { field: c.taxonomy, slugs: Object.keys(cfg.taxonomies[c.taxonomy]?.terms ?? {}) }
        : undefined;
      await indexCollection(db, "dev", name, resolve(dir, c.source!), { taxonomy });
      if (c.source_live) {
        await indexCollection(db, "live", name, resolve(dir, c.source_live), { taxonomy });
      }
    }

    // 10. The outputs-contract OAuth client
    await ensureDevClient(db, adminId);

    // Inject the role-scoped URLs for the app to use. The write roles are separate
    // principals from the read roles — a read pool can never write, whatever the broker does.
    process.env.DEV_DATABASE_URL = dataRoleUrl(appUrl, "warehousd_dev", rolePw);
    process.env.LIVE_DATABASE_URL = dataRoleUrl(appUrl, "warehousd_live", rolePw);
    process.env.DEV_WRITE_DATABASE_URL = dataRoleUrl(appUrl, "warehousd_dev_write", rolePw);
    process.env.LIVE_WRITE_DATABASE_URL = dataRoleUrl(appUrl, "warehousd_live_write", rolePw);

    console.log("bootstrap complete");
  } finally {
    await db.end();
  }
}

// Run when executed directly
if (process.argv[1] === new URL(import.meta.url).pathname) {
  bootstrap().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
