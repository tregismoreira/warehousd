// Run once against a fresh DB: create data roles, apply YAML, seed synth + demo live.
import { Pool } from "pg";
import { loadConfig, applyConfig, generateSynthetic, createAppSchema, indexCollection } from "@warehousd/broker";
import { seedLive } from "../examples/meridian/seed/live";
import { runIndex } from "../packages/cli/src/index";

const url = process.env.APP_DATABASE_URL!;
const dir = process.env.WAREHOUSD_PROJECT_DIR!;

async function main() {
  const db = new Pool({ connectionString: url });
  await db.query(`
    create schema if not exists app;
    create schema if not exists data_synth;
    create schema if not exists data_live;
    do $$ begin
      if not exists (select from pg_roles where rolname='warehousd_dev') then create role warehousd_dev login password 'pw'; end if;
      if not exists (select from pg_roles where rolname='warehousd_live') then create role warehousd_live login password 'pw'; end if;
    end $$;
    grant usage on schema data_synth to warehousd_dev;
    grant usage on schema data_live to warehousd_live;
    grant usage on schema app to warehousd_dev, warehousd_live;`);
  const cfg = loadConfig(dir);
  await createAppSchema(db);
  await applyConfig(db, cfg);
  // truncate before regenerating so re-running bootstrap (e.g. container restart) is idempotent
  for (const name of Object.keys(cfg.collections)) {
    const c = cfg.collections[name];
    // Skip document collections — they are populated via indexCollection, not synthetic generation
    if (c.type === "document") continue;
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
      ('mia','documents', array['id','title','category','summary','owner','updated_at'],'dev','approved'),
      ('mia','people', array['id','full_name','email','department_name'],'dev','approved')`);
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,row_filter) values
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
        ($1,'documents', array['id','title','category','summary','owner','updated_at'],'dev','approved'),
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
