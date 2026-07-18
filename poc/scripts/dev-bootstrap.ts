// Run once against a fresh DB: create data roles, apply YAML, seed synth + demo live.
import { Pool } from "pg";
import { loadConfig, applyConfig, generateSynthetic, createAppSchema } from "@warehousd/broker";
import { seedLive } from "../examples/meridian/seed/live";

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
  for (const name of Object.keys(cfg.collections))
    await db.query(`truncate data_synth.${name} cascade`);
  await generateSynthetic(db, cfg, 42);
  await seedLive(db);
  // Priya's pending salaries request (Marcus's inbox) + her approved dev grants (§9) —
  // only seed if not already present, so re-running bootstrap doesn't duplicate grant rows.
  const existing = await db.query(`select 1 from app.grants where user_id='priya' limit 1`);
  if (existing.rowCount === 0) {
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status) values
      ('priya','documents', array['id','title','category','summary','owner','updated_at'],'dev','approved'),
      ('priya','people', array['id','full_name','email','department_name'],'dev','approved')`);
    await db.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,purpose_label) values
      ('priya','salaries', array['id','person_id','job_title','base_salary','currency','effective_date'],'dev','pending','comp benchmarking')`);
  }
  await db.end();
  console.log("bootstrap complete");
}
main();
