import type { Pool } from "pg";
import { execFileSync } from "child_process";
import { existsSync } from "node:fs";
import { resolve } from "path";
import {
  ensureSchemasAndRoles,
  migrateApp,
  migrateUserOrg,
  loadConfig,
  applyConfig,
  runProjectMigrations,
  generateSynthetic,
  indexCollection,
  loadTaxonomyBindings,
  fileMetadataFields,
  syncDatasetTerms,
  ensureDevClient,
  dataRoleUrl,
  grantableFields,
  type WarehousdConfig,
} from "@warehousd/broker";
import { auth } from "../lib/auth.js";
import { waitForPostgres } from "./wait-for-postgres.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
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

// Seed demo personas (ana/marcus/mia with appropriate roles and grants, plus the extra
// personas LoginForm.tsx offers behind its "more personas" disclosure — ungranted here just
// like mia, since the richer grant matrix is dev-bootstrap.ts's job, not this production path)
async function seedDemoPersonas(db: Pool, cfg: WarehousdConfig): Promise<void> {
  const personas = [
    { id: "ana", email: "ana@demo.local", name: "Ana", role: "admin" },
    { id: "marcus", email: "marcus@demo.local", name: "Marcus", role: "manager" },
    { id: "mia", email: "mia@demo.local", name: "Mia", role: "member" },
    { id: "priya", email: "priya@demo.local", name: "Priya Raghavan", role: "manager" },
    { id: "dan", email: "dan@demo.local", name: "Dan Okafor", role: "member" },
    { id: "elena", email: "elena@demo.local", name: "Elena Vasquez", role: "member" },
    { id: "omar", email: "omar@demo.local", name: "Omar Haddad", role: "member" },
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
      [generatedId],
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
        [a.id, a.accountId, a.providerId, p.id, a.password, a.createdAt, a.updatedAt],
      );
    }
  }

  // Create grants for ana and marcus (they see everything)
  for (const user of ["ana", "marcus"]) {
    const existing = await db.query(`select 1 from app.grants where user_id = $1 limit 1`, [user]);
    if (existing.rowCount === 0) {
      for (const collName of Object.keys(cfg.collections)) {
        // File collections are granted too. Indexing puts documents in the database; it does not
        // make them reachable — search_documents refuses without a grant like anything else.
        // Skipping them left the demo's own admin unable to search a single document.
        const fields = grantableFields(cfg, collName);
        if (fields.length > 0) {
          await db.query(
            `insert into app.grants (user_id, collection, allowed_fields, env, status)
             values ($1, $2, $3, 'dev', 'approved')`,
            [user, collName, fields],
          );
        }
      }
    }
  }
  // Mia gets no grants initially, so the request→approve flow is demonstrable
}

export async function bootstrap(): Promise<void> {
  // Fly sets DATABASE_URL itself when `postgres attach` runs, and those credentials are generated
  // on its side — nothing upstream can pass them in as APP_DATABASE_URL. Accept either, preferring
  // the explicit one so every other deployment path keeps behaving exactly as before.
  if (!process.env.APP_DATABASE_URL && process.env.DATABASE_URL) {
    process.env.APP_DATABASE_URL = process.env.DATABASE_URL;
  }
  const appUrl = requireEnv("APP_DATABASE_URL");
  const dir = requireEnv("WAREHOUSD_PROJECT_DIR");
  const rolePw = requireEnv("WAREHOUSD_DATA_ROLE_PASSWORD");

  // 1. Postgres may still be starting: wait for up to 60s
  const db = await waitForPostgres(appUrl, 60_000);

  try {
    // 2. Schemas + data roles. Must precede migrateApp, which grants to those roles.
    await ensureSchemasAndRoles(db, rolePw);

    // 3. app.* tables. MUST run before the Better Auth migration
    await migrateApp(db);

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

    // 5. The project's own migrations, then YAML → data_synth/data_live tables + views +
    //    app.collections. Idempotent by design.
    //
    //    The order is the contract. applyConfig is additive and will not rewrite a column
    //    underneath live rows — it refuses instead — so a reviewed migration has to have run
    //    first. It then re-derives the plan from the schema, which is why a migration that did not
    //    actually resolve the change still stops the boot. A throw here aborts the Fly release and
    //    the previous version keeps serving, which is exactly what should happen: the alternative
    //    is a release whose config and database disagree about what a column holds.
    const cfg = loadConfig(dir);
    const migrated = await runProjectMigrations(db, dir);
    if (migrated.length > 0)
      console.log(`[entrypoint] applied project migrations: ${migrated.join(", ")}`);
    await applyConfig(db, cfg);
    const demoMode = process.env.WAREHOUSD_DEMO === "true" || cfg.demo;

    // 6. First admin. After the Better Auth migration and after applyConfig
    const adminId = await ensureAdminUser(db);

    // 7. Demo personas — only when opted in
    if (demoMode) {
      await seedDemoPersonas(db, cfg);
    }

    // 8. Synthetic data. Truncate-then-generate so a restart is idempotent
    for (const [name, c] of Object.entries(cfg.collections)) {
      if (c.type === "file") continue; // file collections are indexed, not generated
      await db.query(`truncate data_synth.${name} cascade`);
    }
    await generateSynthetic(db, cfg, Number(process.env.WAREHOUSD_SEED ?? 42));

    // 8.5. Sync dataset-sourced vocabulary terms. Both envs, once — the term set is a property
    // of the data, not of the collection being indexed. `live` legitimately yields nothing on a
    // fresh deployment: data_live is populated by admin import, not by this script.
    await syncDatasetTerms(db, cfg, "dev");
    await syncDatasetTerms(db, cfg, "live");

    // 9. Index file collections
    for (const [name, c] of Object.entries(cfg.collections)) {
      if (c.type !== "file") continue;
      const metadata = fileMetadataFields(c);
      const devTaxonomies = await loadTaxonomyBindings(db, cfg, name, "dev");
      await indexCollection(db, "dev", name, resolve(dir, c.source!), {
        taxonomies: devTaxonomies,
        metadata,
      });
      // `source_live` may be declared and absent. `warehousd deploy` bundles the project into the
      // image but deliberately omits every `source_live` directory, so that live documents never
      // leave the operator's machine and a deployed instance cannot populate data_live — real data
      // arrives through the admin import path instead.
      //
      // indexCollection walks the directory with readdirSync, which throws ENOENT rather than
      // returning nothing. Without this check the release command dies on a config that is doing
      // exactly what it is supposed to, and the deploy aborts. Skip and say so; the dev content is
      // already indexed and the app comes up.
      const liveDir = c.source_live ? resolve(dir, c.source_live) : null;
      if (liveDir && !existsSync(liveDir)) {
        console.warn(
          `[entrypoint] skipping live index of "${name}": ${liveDir} is not present. ` +
            `This is expected on a deployed instance, where live sources are not shipped.`,
        );
        continue;
      }
      if (liveDir) {
        const liveTaxonomies = await loadTaxonomyBindings(db, cfg, name, "live");
        // indexCollection throws on a term its bindings don't know, and a dataset-sourced
        // vocabulary has no live terms until data_live holds rows. Indexing anyway would abort
        // the whole boot on a deployment whose only fault is not having imported data yet, so
        // skip and say why — dev content is already indexed and the app comes up.
        const unpopulated = liveTaxonomies.filter((t) => t.slugs.length === 0);
        if (unpopulated.length) {
          console.warn(
            `[entrypoint] skipping live index of "${name}": no live terms for ` +
              `${unpopulated.map((t) => `"${t.field}"`).join(", ")}. ` +
              `Import rows into data_live for the source collection, then re-run.`,
          );
          continue;
        }
        await indexCollection(db, "live", name, liveDir, {
          taxonomies: liveTaxonomies,
          metadata,
        });
      }
    }

    // 10. The outputs-contract OAuth client. The CLI generates the secret and holds the only
    // plaintext copy (.warehousd/state.json, mode 0600); this stores a hash of it, so `start` can
    // still print it on a later run without the database being able to.
    await ensureDevClient(db, adminId, process.env.WAREHOUSD_DEV_CLIENT_SECRET);

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
