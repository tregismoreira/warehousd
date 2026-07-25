// Run once against a fresh DB: create data roles, apply YAML, seed synth + demo live.
import { Pool } from "pg";
import { execSync } from "child_process";
import { loadConfig, applyConfig, generateSynthetic, createAppSchema, indexCollection, ensureSchemasAndRoles } from "@warehousd/broker";
import { seedLive } from "../examples/meridian/seed/live";
import { runIndex } from "../packages/cli/src/index";
import { auth } from "../apps/web/lib/auth";

const url = process.env.APP_DATABASE_URL!;
const dir = process.env.WAREHOUSD_PROJECT_DIR!;

// Seed the three demo personas as real Better Auth local-credential users.
// Fixed ids keep them aligned with the pre-seeded app.grants rows (user_id = 'ana'|'marcus'|'mia').
async function seedPersonaUsers(db: Pool) {
  const personas = [
    { id: "ana",    email: "ana@meridian.demo",    name: "Ana",    role: "admin" },
    { id: "marcus", email: "marcus@meridian.demo", name: "Marcus", role: "manager" },
    { id: "mia",    email: "mia@meridian.demo",    name: "Mia",    role: "member" },
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
    // Delete sessions and accounts, then update user id and role.
    // This avoids foreign key constraint violations.
    await db.query(`delete from app."session" where "userId"=$1`, [generatedId]);
    await db.query(`delete from app."account" where "userId"=$1`, [generatedId]);
    await db.query(`update app."user" set id=$1, role=$2 where id=$3`, [p.id, p.role, generatedId]);
  }
}

async function main() {
  const db = new Pool({ connectionString: url });
  await ensureSchemasAndRoles(db, "pw");
  const cfg = loadConfig(dir);
  await createAppSchema(db);
  // Ensure Better Auth tables exist (user/session/account/verification) before seeding users.
  execSync("npx @better-auth/cli migrate --config apps/web/lib/auth.ts -y", { cwd: process.cwd(), stdio: "inherit" });
  await seedPersonaUsers(db);
  await applyConfig(db, cfg);
  // truncate before regenerating so re-running bootstrap (e.g. container restart) is idempotent
  for (const name of Object.keys(cfg.collections)) {
    const c = cfg.collections[name];
    // Skip file collections — they are populated via indexCollection, not synthetic generation
    if (c.type === "file") continue;
    await db.query(`truncate data_synth.${name} cascade`);
  }
  await generateSynthetic(db, cfg, 42);
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
