import { Pool } from "pg";
import { ADMIN, BASE, cloneTemplate } from "../../../../packages/broker/test/helpers/templates";

export const PERSONAS = [
  { id: "ana", email: "ana@harbor.demo", name: "Ana", role: "admin" },
  { id: "marcus", email: "marcus@harbor.demo", name: "Marcus", role: "manager" },
  { id: "mia", email: "mia@harbor.demo", name: "Mia", role: "member" },
];

// Point auth at `appUrl` BEFORE anything imports lib/auth — it reads APP_DATABASE_URL at
// module load.
function setAuthEnv(appUrl: string, projectDir?: string) {
  process.env.APP_DATABASE_URL = appUrl;
  process.env.BETTER_AUTH_SECRET ??= "test-secret-at-least-32-chars-long-000";
  process.env.BETTER_AUTH_URL ??= "http://localhost:8722";
  // Keycloak only. The fake IdP binds an ephemeral port and appends its own origin in
  // startFakeIdp, which every caller runs before this.
  process.env.WAREHOUSD_TRUSTED_ORIGINS ??= "http://127.0.0.1:8780";
  process.env.WAREHOUSD_PROJECT_DIR = projectDir ?? new URL("../../../../examples/harbor", import.meta.url).pathname;
}

// The full bootstrap, run against an empty database. globalSetup calls it once to build the
// template every other test clones, and entrypoint-bootstrap.integration.test.ts calls it
// against a virgin database — so the recipe stays exercised end to end and the two callers
// cannot drift apart.
export async function bootstrapWebDb(appUrl: string): Promise<void> {
  const db = new Pool({ connectionString: appUrl, max: 4 });

  // Exercise the same schema/role bootstrap the container entrypoint uses, so tests catch
  // drift in it. It provisions dev/live only; warehousd_import is Phase 5's INSERT-only
  // role for the admin import path and has to be created alongside.
  const { ensureSchemasAndRoles } = await import("@warehousd/broker");
  await ensureSchemasAndRoles(db, "pw");
  await db.query(`
    do $$ begin
      if not exists (select from pg_roles where rolname='warehousd_import') then create role warehousd_import login password 'pw'; end if;
    end $$;
    grant usage on schema data_live to warehousd_import;`);

  setAuthEnv(appUrl);

  const { createAppSchema } = await import("@warehousd/broker");
  await createAppSchema(db);

  const { auth } = await import("../../lib/auth");
  // Run Better Auth migration via CLI. This is the slowest step in the bootstrap, which is
  // why it now runs once per template rather than once per test database — npx's resolution
  // overhead no longer matters at that frequency, and `pnpm exec` cannot reach the binary
  // from here anyway (it is linked as `better-auth` under apps/web, not at this cwd).
  const { execSync } = await import("node:child_process");
  const mvpDir = new URL("../../../../", import.meta.url).pathname;
  execSync(`npx @better-auth/cli migrate --config apps/web/lib/auth.ts -y`, {
    cwd: mvpDir,
    stdio: "pipe",
    env: { ...process.env, APP_DATABASE_URL: appUrl },
  });

  // Same step the container entrypoint runs right after the Better Auth migration: push the
  // org default onto the generated user.orgId column so direct SQL inserts below still work.
  const { migrateUserOrg } = await import("@warehousd/broker");
  await migrateUserOrg(db);

  for (const p of PERSONAS) {
    const res = await auth.api.signUpEmail({ body: { email: p.email, password: "demo", name: p.name } });
    const gen = res.user.id;
    // Disable foreign key constraints to allow user ID updates
    await db.query(`set session_replication_role = replica`);
    await db.query(`update app."user" set id=$1, role=$2 where id=$3`, [p.id, p.role, gen]);
    await db.query(`update app."account" set "userId"=$1 where "userId"=$2`, [p.id, gen]);
    await db.query(`update app."session" set "userId"=$1 where "userId"=$2`, [p.id, gen]);
    await db.query(`set session_replication_role = default`);
  }

  await db.end();
}

async function cloneAndOpen(kind: string, label: string, projectDir?: string) {
  const dbName = `wh_web_${label}_${process.pid}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  await cloneTemplate(kind, dbName);

  const appUrl = `${BASE}/${dbName}`;
  const db = new Pool({ connectionString: appUrl, max: 4 });
  setAuthEnv(appUrl, projectDir);
  const { auth } = await import("../../lib/auth");

  const handle = {
    dbName,
    appUrl,
    auth,
    async end() {
      await db.end();
      const a = new Pool({ connectionString: ADMIN, max: 1 });
      await a.query(`drop database if exists ${dbName} with (force)`);
      await a.end();
    },
  };
  return { handle, db };
}

export async function setupWebDb(label: string, opts: { seedPersonas?: boolean; projectDir?: string } = {}) {
  const { seedPersonas = true, projectDir } = opts;
  const { handle, db } = await cloneAndOpen("web", label, projectDir);

  if (!seedPersonas) {
    // The template always carries them, so a caller testing a cluster with no local
    // credentials has to have them taken back out. Children first — the Better Auth tables
    // reference app."user" without ON DELETE CASCADE.
    const ids = PERSONAS.map((p) => p.id);
    await db.query(`delete from app."session" where "userId" = any($1)`, [ids]);
    await db.query(`delete from app."account" where "userId" = any($1)`, [ids]);
    await db.query(`delete from app."user" where id = any($1)`, [ids]);
  }

  return handle;
}

// Applies the harbor YAML, generates synthetic data, seeds live data, and indexes the file
// collections for both envs — same recipe as scripts/dev-bootstrap.ts. Layered on top of an
// already-bootstrapped database (globalSetup builds the web-with-data template from the web
// one), so it must not re-enter bootstrapWebDb: lib/auth caches APP_DATABASE_URL at module
// load, and a second bootstrap in the same process would seed personas into the first database.
export async function applyHarborData(appUrl: string): Promise<void> {
  const { loadConfig, applyConfig, generateSynthetic, indexCollection, syncDatasetTerms, loadTaxonomyBindings, fileMetadataFields } = await import("@warehousd/broker");
  const harborDir = new URL("../../../../examples/harbor", import.meta.url).pathname;
  const { seedLive } = await import("../../../../examples/harbor/seed/live");
  const cfg = loadConfig(harborDir);

  const db = new Pool({ connectionString: appUrl, max: 4 });
  await applyConfig(db, cfg);
  await generateSynthetic(db, cfg, 42);
  await syncDatasetTerms(db, cfg, "dev");
  await seedLive(db);
  await syncDatasetTerms(db, cfg, "live");
  for (const [name, c] of Object.entries(cfg.collections)) {
    if (c.type !== "file") continue;
    const metadata = fileMetadataFields(c);
    const devTaxonomies = await loadTaxonomyBindings(db, cfg, name, "dev");
    await indexCollection(db, "dev", name, `${harborDir}/${c.source}`, { taxonomies: devTaxonomies, metadata });
    if (c.source_live) {
      const liveTaxonomies = await loadTaxonomyBindings(db, cfg, name, "live");
      await indexCollection(db, "live", name, `${harborDir}/${c.source_live}`, { taxonomies: liveTaxonomies, metadata });
    }
  }
  await db.end();
}

// Full-data variant of setupWebDb. Points DEV_DATABASE_URL/LIVE_DATABASE_URL at the
// warehousd_dev/warehousd_live roles the bootstrap creates on this database, so apps/web's
// getBroker() can serve real dev/live queries.
export async function setupWebDbWithData(label: string) {
  const { handle } = await cloneAndOpen("web_data", label);

  process.env.DEV_DATABASE_URL = `postgres://warehousd_dev:pw@127.0.0.1:54330/${handle.dbName}`;
  process.env.LIVE_DATABASE_URL = `postgres://warehousd_live:pw@127.0.0.1:54330/${handle.dbName}`;
  process.env.IMPORT_DATABASE_URL = `postgres://warehousd_import:pw@127.0.0.1:54330/${handle.dbName}`;

  return handle;
}

// Generic variant of setupWebDbWithData for a caller-supplied project dir instead of the
// hardcoded harbor one. Applies the config's DDL (creating writable/file collection tables
// and granting the dev/dev_write/live/live_write roles) and wires DEV_DATABASE_URL et al. at
// the roles setupWebDb already created — without harbor's seedLive/indexCollection steps,
// which assume harbor's specific seed layout. Callers that need file-collection content
// insert rows directly via SQL/indexCollection themselves.
export async function setupWebDbWithConfig(label: string, projectDir: string) {
  const base = await setupWebDb(label, { projectDir });
  const { loadConfig, applyConfig } = await import("@warehousd/broker");
  const cfg = loadConfig(projectDir);

  const db = new Pool({ connectionString: base.appUrl, max: 4 });
  await applyConfig(db, cfg);
  await db.end();

  process.env.DEV_DATABASE_URL = `postgres://warehousd_dev:pw@127.0.0.1:54330/${base.dbName}`;
  process.env.LIVE_DATABASE_URL = `postgres://warehousd_live:pw@127.0.0.1:54330/${base.dbName}`;
  process.env.DEV_WRITE_DATABASE_URL = `postgres://warehousd_dev_write:pw@127.0.0.1:54330/${base.dbName}`;
  process.env.LIVE_WRITE_DATABASE_URL = `postgres://warehousd_live_write:pw@127.0.0.1:54330/${base.dbName}`;
  process.env.IMPORT_DATABASE_URL = `postgres://warehousd_import:pw@127.0.0.1:54330/${base.dbName}`;

  return { ...base, cfg };
}

// Sign in and return the Set-Cookie value as a Cookie header for subsequent requests.
export async function signIn(auth: any, email: string, password: string): Promise<string> {
  const res = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  // Reduce "name=value; attrs" to just "name=value" pairs joined for a Cookie header.
  return setCookie.split(/,(?=[^;]+?=)/).map((c: string) => c.split(";")[0].trim()).join("; ");
}
