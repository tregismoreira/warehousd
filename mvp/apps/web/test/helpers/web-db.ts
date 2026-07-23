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
  await db.query(`
    create schema app; create schema data_synth; create schema data_live;
    do $$ begin
      if not exists (select from pg_roles where rolname='warehousd_dev') then create role warehousd_dev login password 'pw'; end if;
      if not exists (select from pg_roles where rolname='warehousd_live') then create role warehousd_live login password 'pw'; end if;
    end $$;
    grant usage on schema data_synth to warehousd_dev;
    grant usage on schema data_live to warehousd_live;
    grant usage on schema app to warehousd_dev, warehousd_live;`);

  // Point auth at this DB BEFORE importing lib/auth (it reads APP_DATABASE_URL at module load).
  process.env.APP_DATABASE_URL = appUrl;
  process.env.BETTER_AUTH_SECRET ??= "test-secret-at-least-32-chars-long-000";
  process.env.BETTER_AUTH_URL ??= "http://localhost:8722";

  const { createAppSchema } = await import("@warehousd/broker");
  await createAppSchema(db);

  const { auth } = await import("../../lib/auth");
  // Run Better Auth migration (use the approach confirmed in Task 9 Step 2).
  const { getMigrations } = await import("better-auth/db");
  const { runMigrations } = await getMigrations((auth as any).options);
  await runMigrations();

  const personas = [
    { id: "ana", email: "ana@meridian.demo", name: "Ana", role: "admin" },
    { id: "marcus", email: "marcus@meridian.demo", name: "Marcus", role: "manager" },
    { id: "mia", email: "mia@meridian.demo", name: "Mia", role: "member" },
  ];
  for (const p of personas) {
    const res = await auth.api.signUpEmail({ body: { email: p.email, password: "demo", name: p.name } });
    const gen = res.user.id;
    await db.query(`update app."user" set id=$1, role=$2 where id=$3`, [p.id, p.role, gen]);
    await db.query(`update app."account" set "userId"=$1 where "userId"=$2`, [p.id, gen]);
  }

  return {
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
