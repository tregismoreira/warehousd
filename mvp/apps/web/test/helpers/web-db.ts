import { Pool } from "pg";

const ADMIN = "postgres://postgres:postgres@127.0.0.1:54330/postgres";
const BASE = "postgres://postgres:postgres@127.0.0.1:54330";

export async function setupWebDb(label: string) {
  const dbName = `wh_web_${label}_${process.pid}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const admin = new Pool({ connectionString: ADMIN });
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`create database ${dbName}`);
  await admin.end();

  const appUrl = `${BASE}/${dbName}`;
  const db = new Pool({ connectionString: appUrl });
  const { ensureSchemasAndRoles } = await import("@warehousd/broker");
  await ensureSchemasAndRoles(db, "pw");

  // Point auth at this DB BEFORE importing lib/auth (it reads APP_DATABASE_URL at module load).
  process.env.APP_DATABASE_URL = appUrl;
  process.env.BETTER_AUTH_SECRET ??= "test-secret-at-least-32-chars-long-000";
  process.env.BETTER_AUTH_URL ??= "http://localhost:8722";
  process.env.WAREHOUSD_PROJECT_DIR = new URL("../../../../examples/meridian", import.meta.url).pathname;

  const { createAppSchema } = await import("@warehousd/broker");
  await createAppSchema(db);

  const { auth } = await import("../../lib/auth");
  // Run Better Auth migration via CLI.
  const { execSync } = await import("node:child_process");
  const mvpDir = new URL("../../../../", import.meta.url).pathname;
  execSync(`npx @better-auth/cli migrate --config apps/web/lib/auth.ts -y`, {
    cwd: mvpDir,
    stdio: "pipe",
    env: { ...process.env, APP_DATABASE_URL: appUrl },
  });

  const personas = [
    { id: "ana", email: "ana@meridian.demo", name: "Ana", role: "admin" },
    { id: "marcus", email: "marcus@meridian.demo", name: "Marcus", role: "manager" },
    { id: "mia", email: "mia@meridian.demo", name: "Mia", role: "member" },
  ];
  for (const p of personas) {
    const res = await auth.api.signUpEmail({ body: { email: p.email, password: "demo", name: p.name } });
    const gen = res.user.id;
    // Disable foreign key constraints to allow user ID updates
    await db.query(`set session_replication_role = replica`);
    await db.query(`update app."user" set id=$1, role=$2 where id=$3`, [p.id, p.role, gen]);
    await db.query(`update app."account" set "userId"=$1 where "userId"=$2`, [p.id, gen]);
    await db.query(`update app."session" set "userId"=$1 where "userId"=$2`, [p.id, gen]);
    await db.query(`set session_replication_role = default`);
  }

  return {
    dbName,
    appUrl,
    auth,
    async end() {
      await db.end();
      const a = new Pool({ connectionString: ADMIN });
      await a.query(`drop database if exists ${dbName} with (force)`);
      await a.end();
    },
  };
}

// Full-data variant of setupWebDb: applies the meridian YAML, generates synthetic data,
// seeds live data, and indexes the policies collection for both envs — same recipe as
// scripts/dev-bootstrap.ts, scoped to a disposable test database. Also points
// DEV_DATABASE_URL/LIVE_DATABASE_URL at the warehousd_dev/warehousd_live roles setupWebDb
// already creates on this database, so apps/web's getBroker() can serve real dev/live queries.
export async function setupWebDbWithData(label: string) {
  const base = await setupWebDb(label);
  const { loadConfig, applyConfig, generateSynthetic, indexCollection } = await import("@warehousd/broker");
  const meridianDir = new URL("../../../../examples/meridian", import.meta.url).pathname;
  const { seedLive } = await import("../../../../examples/meridian/seed/live");
  const cfg = loadConfig(meridianDir);

  const db = new Pool({ connectionString: base.appUrl });
  await applyConfig(db, cfg);
  await generateSynthetic(db, cfg, 42);
  await seedLive(db);
  const policiesTaxonomy = cfg.collections.policies?.taxonomy
    ? { field: cfg.collections.policies.taxonomy, slugs: Object.keys(cfg.taxonomies[cfg.collections.policies.taxonomy]?.terms ?? {}) }
    : undefined;
  await indexCollection(db, "dev", "policies", `${meridianDir}/seed/docs-dev`, { taxonomy: policiesTaxonomy });
  await indexCollection(db, "live", "policies", `${meridianDir}/seed/docs-live`, { taxonomy: policiesTaxonomy });
  await db.end();

  process.env.DEV_DATABASE_URL = `postgres://warehousd_dev:pw@127.0.0.1:54330/${base.dbName}`;
  process.env.LIVE_DATABASE_URL = `postgres://warehousd_live:pw@127.0.0.1:54330/${base.dbName}`;

  return base;
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
