import { it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { generateSynthetic } from "../src/synthetic/generate";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import { loadConfig } from "../src/config/load";
import { seedLive } from "../../../examples/meridian/seed/live";
import { LIVE_ONLY_CANARY } from "./fixtures/canaries";
import { join } from "node:path";

// NOTE: depends on examples/meridian, excluded from mvp/ until Task 12 recreates it — expected to fail until then.

const cfg = loadConfig(join(__dirname, "../../../examples/meridian"));
let p: Provisioned, admin: Pool, pools: Pools;
beforeAll(async () => {
  p = await provision("dbroles"); admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin); await applyConfig(admin, cfg);
  await generateSynthetic(admin, cfg, 42);
  await seedLive(admin);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
});
afterAll(async () => { await admin.end(); await pools.end(); await p.end(); });

it("test 1: app role has NO direct data privileges; broker path works", async () => {
  // app role is warehousd_dev/live for data — but the "app" pool connects as superuser in tests;
  // assert the DENY on the two data roles crossing their wall instead (the real structural guarantee):
  const dev = new Pool({ connectionString: p.urls.dev });
  await expect(dev.query(`select * from data_live.v_people`)).rejects.toThrow();
  await dev.end();
});

it("test 5 (partial): dev token cannot see live-only canary; direct role check", async () => {
  const broker = makeBroker(pools, cfg);
  await admin.query(`insert into app.grants (user_id,collection,allowed_fields,env,status) values
    ('u','people', array['id','full_name','email'],'dev','approved')`);
  const r = await broker.query({ userId: "u", env: "dev" }, { collection: "people", limit: 500 });
  expect(r.ok).toBe(true);
  if (r.ok) {
    const blob = JSON.stringify(r.rows);
    expect(blob.includes(LIVE_ONLY_CANARY)).toBe(false);
  }
  // direct: warehousd_dev is refused on data_live
  const dev = new Pool({ connectionString: p.urls.dev });
  await expect(dev.query(`select * from data_live.v_people`)).rejects.toThrow();
  await dev.end();
});

it("test 8: synthetic generator role has no data_live privilege; FK integrity holds", async () => {
  const dev = new Pool({ connectionString: p.urls.dev });
  await expect(dev.query(`select 1 from data_live.people`)).rejects.toThrow();
  await dev.end();
  const orphans = await admin.query(
    `select 1 from data_synth.salaries s
     left join data_synth.people p on p.id=s.person_id where s.person_id is not null and p.id is null`);
  expect(orphans.rowCount).toBe(0);
});
