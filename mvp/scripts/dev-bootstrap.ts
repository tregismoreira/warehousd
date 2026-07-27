// Run once against a fresh DB: create data roles, apply YAML, seed synth + demo live.
import { Pool } from "pg";
import { execSync } from "child_process";
import { loadConfig, applyConfig, regenerateSynthetic, createAppSchema, indexCollection, ensureSchemasAndRoles } from "@warehousd/broker";
import { seedLive } from "../examples/meridian/seed/live";
import { runIndex } from "../packages/cli/src/index";
import { auth } from "../apps/web/lib/auth";

const url = process.env.APP_DATABASE_URL!;
const dir = process.env.WAREHOUSD_PROJECT_DIR!;

// Seed the three demo personas as real Better Auth local-credential users.
// Fixed ids keep them aligned with the pre-seeded app.grants rows (user_id = 'ana'|'marcus'|'mia').
async function seedPersonaUsers(db: Pool) {
  const personas = [
    // Must match apps/web/scripts/entrypoint.ts and the buttons hardcoded in
    // app/login/LoginForm.tsx — otherwise the demo buttons shown by this dev
    // flow reference users that were never seeded and sign-in always fails.
    { id: "ana",    email: "ana@demo.local",    name: "Ana",    role: "admin" },
    { id: "marcus", email: "marcus@demo.local", name: "Marcus", role: "manager" },
    { id: "mia",    email: "mia@demo.local",    name: "Mia",    role: "member" },
  ];
  for (const p of personas) {
    const exists = await db.query(`select 1 from app."user" where id=$1`, [p.id]);
    if (exists.rowCount && exists.rowCount > 0) continue;
    // Use Better Auth's sign-up so the password is hashed with its own scheme,
    // then fix the id + role directly (sign-up assigns a random id and default role).
    const res = await auth.api.signUpEmail({
      body: { email: p.email, password: "demo", name: p.name },
    });
    const generatedId = res.user.id;
    // account.userId has an ON DELETE CASCADE (not ON UPDATE) FK to user.id, so the
    // referencing account row must be gone before user.id can be renamed. Preserve its
    // password hash and reinsert it under the new id — deleting outright leaves the
    // persona with no credential, so demo sign-in silently never works.
    const account = await db.query(
      `select * from app."account" where "userId"=$1 and "providerId"='credential'`,
      [generatedId]
    );
    await db.query(`delete from app."session" where "userId"=$1`, [generatedId]);
    await db.query(`delete from app."account" where "userId"=$1`, [generatedId]);
    await db.query(`update app."user" set id=$1, role=$2 where id=$3`, [p.id, p.role, generatedId]);
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
}

async function main() {
  const db = new Pool({ connectionString: url });
  // Schemas + the dev/live data roles, shared with the container entrypoint.
  await ensureSchemasAndRoles(db, "pw");
  // warehousd_import is Phase 5's INSERT-only role for the admin import path; the shared
  // helper above predates it and only provisions dev/live, so create it here. Without it
  // IMPORT_DATABASE_URL (see docs/SETUP.md) points at a role that does not exist.
  await db.query(`
    do $$ begin
      if not exists (select from pg_roles where rolname='warehousd_import') then create role warehousd_import login password 'pw'; end if;
    end $$;
    grant usage on schema data_live to warehousd_import;`);
  const cfg = loadConfig(dir);
  await createAppSchema(db);
  // Ensure Better Auth tables exist (user/session/account/verification) before seeding users.
  execSync("npx @better-auth/cli migrate --config apps/web/lib/auth.ts -y", { cwd: process.cwd(), stdio: "inherit" });
  await seedPersonaUsers(db);
  await applyConfig(db, cfg);
  // truncate before regenerating so re-running bootstrap (e.g. container restart) is idempotent
  await regenerateSynthetic(db, cfg, 42);
  await seedLive(db);
  // Index policies collection from seed docs (dev and live environments)
  const policiesTaxonomy = cfg.collections.policies?.taxonomy
    ? { field: cfg.collections.policies.taxonomy, slugs: Object.keys(cfg.taxonomies[cfg.collections.policies.taxonomy]?.terms ?? {}) }
    : undefined;
  const devIndexed = await indexCollection(db, "dev", "policies", `${dir}/seed/docs-dev`, { taxonomy: policiesTaxonomy });
  const liveIndexed = await indexCollection(db, "live", "policies", `${dir}/seed/docs-live`, { taxonomy: policiesTaxonomy });
  // Mia's pending salaries request (Marcus's inbox) + her approved dev grants (§9) —
  // only seed if not already present, so re-running bootstrap doesn't duplicate grant rows.
  const existing = await db.query(`select 1 from app.grants where user_id='mia' limit 1`);
  if (existing.rowCount === 0) {
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status) values
      ('mia','announcements', array['id','title','category','summary','owner','updated_at'],'dev','approved'),
      ('mia','people', array['id','full_name','email','department_name'],'dev','approved')`);
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,document_filter) values
      ('mia','policies', array['title','content','owner','updated_at','category'],'dev','approved',
       '{"field":"category","op":"in","value":["hr","benefits"]}'::jsonb)`);
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,purpose_label) values
      ('mia','salaries', array['id','person_id','job_title','base_salary','currency','effective_date'],'dev','pending','comp benchmarking')`);
  }
  // Marcus (manager) and Ana (admin) see everything (README §"grants" — managers get fields: "*").
  for (const user of ["marcus", "ana"]) {
    const already = await db.query(`select 1 from app.grants where user_id=$1 limit 1`, [user]);
    if (already.rowCount === 0) {
      await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status) values
        ($1,'announcements', array['id','title','category','summary','owner','updated_at'],'dev','approved'),
        ($1,'departments', array['id','name'],'dev','approved'),
        ($1,'people', array['id','full_name','email','department_name','department_id'],'dev','approved'),
        ($1,'salaries', array['id','person_id','job_title','base_salary','currency','effective_date'],'dev','approved'),
        ($1,'metrics', array['id','date','revenue','active_customers','region'],'dev','approved'),
        ($1,'policies', array['title','content','owner','updated_at','category'],'dev','approved')`,
        [user]);
    }
  }
  await db.end();
  console.log("bootstrap complete (indexed dev policies: " + devIndexed.indexed + ", live policies: " + liveIndexed.indexed + ")");
}
main();
