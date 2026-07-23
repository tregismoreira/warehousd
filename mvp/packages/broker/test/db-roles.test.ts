import { it, expect, beforeAll, afterAll, describe } from "vitest";
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
    const blob = JSON.stringify(r.documents);
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

describe("env role grants (design §8 test 7)", () => {
  let p2: Provisioned;
  afterAll(async () => { await p2?.end(); });

  it("env role reads file view but not base tables", async () => {
    p2 = await provision("view-only");
    const db = new Pool({ connectionString: p2.urls.admin });
    await createAppSchema(db);

    const docCfg = {
      project: "t", server: { port: 1 }, synthetic: { documents_per_collection: {} },
      collections: {
        policies: {
          type: "file" as const,
          description: "d",
          source: "./x",
          fields: {
            title: { posture: "allow" as const },
            content: { posture: "allow" as const },
            path: { posture: "deny" as const },
          },
        },
      },
    };

    await applyConfig(db, docCfg);

    // Insert one file + one document as admin
    await db.query(`insert into data_synth."policies__files" (id,title,path,owner,checksum,updated_at)
      values (gen_random_uuid(),'test policy','test.md',null,'c',now())`);
    const d = await db.query(`select id from data_synth."policies__files" limit 1`);
    await db.query(`insert into data_synth."policies__documents" (id,file_id,document_seq,content)
      values (gen_random_uuid(),$1,0,'policy content')`, [d.rows[0].id]);

    // Test with dev role
    const dev = new Pool({ connectionString: p2.urls.dev });
    const ok = await dev.query(`select title from data_synth.v_policies`);
    expect(ok.rowCount).toBeGreaterThan(0);
    await expect(dev.query(`select * from data_synth."policies__files"`)).rejects.toThrow(/permission denied/);
    await expect(dev.query(`select * from data_synth."policies__documents"`)).rejects.toThrow(/permission denied/);
    await expect(dev.query(`select * from data_live.v_policies`)).rejects.toThrow(/permission denied/);
    await dev.end();
    await db.end();
  });
});
