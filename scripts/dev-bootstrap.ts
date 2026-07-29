// Run once against a fresh DB: create data roles, apply YAML, seed synth + demo live.
import { Pool } from "pg";
import { execSync } from "child_process";
import { loadConfig, applyConfig, regenerateSynthetic, createAppSchema, indexCollection, syncDatasetTerms, loadTaxonomyBindings, fileMetadataFields, ensureSchemasAndRoles, grantableFields } from "@warehousd/broker";
import { seedLive } from "../examples/harbor/seed/live";
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
    { id: "priya",  email: "priya@demo.local",  name: "Priya Raghavan", role: "manager" },
    { id: "dan",    email: "dan@demo.local",    name: "Dan Okafor",     role: "member" },
    { id: "elena",  email: "elena@demo.local",  name: "Elena Vasquez",  role: "member" },
    { id: "omar",   email: "omar@demo.local",   name: "Omar Haddad",    role: "member" },
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
  // IMPORT_DATABASE_URL (see CONTRIBUTING.md) points at a role that does not exist.
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
  // Sync dataset-sourced vocabulary terms for dev
  await syncDatasetTerms(db, cfg, "dev");
  await seedLive(db);
  // Sync dataset-sourced vocabulary terms for live
  await syncDatasetTerms(db, cfg, "live");
  // Index file collections from seed docs (dev and live environments)
  const indexed: string[] = [];
  for (const [name, c] of Object.entries(cfg.collections)) {
    if (c.type !== "file") continue;
    const metadata = fileMetadataFields(c);
    const devTaxonomies = await loadTaxonomyBindings(db, cfg, name, "dev");
    const dev = await indexCollection(db, "dev", name, `${dir}/${c.source}`, { taxonomies: devTaxonomies, metadata });
    let live = 0;
    if (c.source_live) {
      const liveTaxonomies = await loadTaxonomyBindings(db, cfg, name, "live");
      live = (await indexCollection(db, "live", name, `${dir}/${c.source_live}`, { taxonomies: liveTaxonomies, metadata })).indexed;
    }
    indexed.push(`${name} dev:${dev.indexed} live:${live}`);
  }
  // Mia's pending salaries request (Marcus's inbox) + her approved dev grants (§9) —
  // only seed if not already present, so re-running bootstrap doesn't duplicate grant rows.
  const existing = await db.query(`select 1 from app.grants where user_id='mia' limit 1`);
  if (existing.rowCount === 0) {
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status) values
      ('mia','announcements', array['id','title','department','summary','owner','updated_at'],'dev','approved'),
      ('mia','people', array['id','full_name','email','department_name'],'dev','approved')`);
    // single-vocabulary scoped: department only (tags is not part of this grant).
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,document_filter) values
      ('mia','policies', array['title','content','owner','updated_at','department'],'dev','approved',
       '[{"field":"department","op":"in","value":["hr","finance"]}]'::jsonb)`);
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,purpose_label) values
      ('mia','salaries', array['id','person_id','job_title','base_salary','currency','effective_date'],'dev','pending','comp benchmarking')`);
  }
  // Marcus (manager) and Ana (admin) see everything (README §"grants" — managers get fields: "*").
  // Derived from the config rather than listed literally: a hand-written list silently stops
  // covering the demo the moment a collection is added, which is how `matters` — the whole point
  // of the view_join work — ended up ungranted for every persona. Deny-posture fields are not
  // grantable, so `home_address`, `ssn` and `path` stay out of reach here as everywhere else.
  for (const user of ["marcus", "ana"]) {
    const already = await db.query(`select 1 from app.grants where user_id=$1 limit 1`, [user]);
    if (already.rowCount === 0) {
      for (const name of Object.keys(cfg.collections)) {
        const fields = grantableFields(cfg, name);
        if (!fields.length) continue;
        await db.query(
          `insert into app.grants (user_id,collection,allowed_fields,env,status)
           values ($1,$2,$3,'dev','approved')`, [user, name, fields]);
      }
    }
  }

  // Priya (manager, partner): live-env grants + full-collection access to matters.
  const priyaExisting = await db.query(`select 1 from app.grants where user_id='priya' limit 1`);
  if (priyaExisting.rowCount === 0) {
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status) values
      ('priya','matters',
       array['id','matter_number','client_id','client_name','responsible_attorney_id',
             'responsible_attorney_name','originating_attorney_id','originating_attorney_name'],
       'live','approved')`);
  }

  // Dan (member, paralegal): multi-predicate + multi-value — case_files scoped to one client
  // AND an overlap with a set of tags (both predicates AND'd, the second array-overlap).
  const danExisting = await db.query(`select 1 from app.grants where user_id='dan' limit 1`);
  if (danExisting.rowCount === 0) {
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,document_filter) values
      ('dan','case_files',
       array['title','content','owner','updated_at','client','tags','matter_number','document_type','confidentiality','filed_date'],
       'dev','approved',
       '[{"field":"client","op":"in","value":["c-0042"]},{"field":"tags","op":"in","value":["litigation","discovery","filings"]}]'::jsonb)`);
  }

  // Elena (member, finance): field-trimmed invoices/expenses, a trust_accounts grant with a
  // future expiry ("expiring"), and a separate collection whose grant has already expired.
  const elenaExisting = await db.query(`select 1 from app.grants where user_id='elena' limit 1`);
  if (elenaExisting.rowCount === 0) {
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status) values
      ('elena','invoices', array['id','invoice_number','client_id','amount','status'],'dev','approved'),
      ('elena','expenses', array['id','matter_id','category','amount'],'dev','approved')`);
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at) values
      ('elena','trust_accounts', array['id','client_id','balance','currency','opened_date'],'dev','approved',
       now() + interval '90 days')`);
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at) values
      ('elena','vendors', array['id','name','category','active'],'dev','approved',
       now() - interval '10 days')`);
  }

  // Omar (member, HR): a metadata-field-scoped grant (confidentiality, not a vocabulary), a
  // path-scoped grant, one denied request, and one revoked grant.
  const omarExisting = await db.query(`select 1 from app.grants where user_id='omar' limit 1`);
  if (omarExisting.rowCount === 0) {
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,document_filter) values
      ('omar','case_files',
       array['title','content','owner','updated_at','client','tags','matter_number','document_type','confidentiality','filed_date'],
       'dev','approved',
       '[{"field":"confidentiality","op":"in","value":["internal"]}]'::jsonb)`);
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,document_filter) values
      ('omar','policies', array['title','content','owner','updated_at','department'],'dev','approved',
       '[{"field":"path","op":"in","value":["pto.md"]}]'::jsonb)`);
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,decided_by,decided_at) values
      ('omar','salaries', array['id','job_title','base_salary'],'dev','denied','marcus',now())`);
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,decided_by,decided_at) values
      ('omar','performance_reviews', array['id','person_id','review_date','rating'],'dev','revoked','marcus',now())`);
  }

  // Dan also gets the third file collection, scoped by department rather than client — without
  // it `precedents` is the one collection in the config no persona can reach, so its bound
  // vocabularies and metadata fields never get exercised by the demo.
  const danPrecedents = await db.query(
    `select 1 from app.grants where user_id='dan' and collection='precedents' limit 1`);
  if (danPrecedents.rowCount === 0) {
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,document_filter) values
      ('dan','precedents', array['title','content','owner','updated_at','department','tags','jurisdiction','last_reviewed'],
       'dev','approved',
       '[{"field":"department","op":"in","value":["litigation"]}]'::jsonb)`);
  }
  await db.end();
  console.log("bootstrap complete (indexed " + indexed.join(", ") + ")");
}
main();
