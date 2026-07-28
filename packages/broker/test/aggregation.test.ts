import { it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import type { WarehousdConfig } from "../src/config/schema";

const cfg: WarehousdConfig = {
  project: "t", server: { port: 1 }, synthetic: { documents_per_collection: {} },
  collections: { salaries: { description: "comp", fields: {
    id: { type: "uuid", posture: "allow", pk: true },
    job_title: { type: "text", posture: "allow" },
    base_salary: { type: "numeric", posture: "allow" },
    effective_date: { type: "date", posture: "allow" },
  }}},
};
let p: Provisioned, admin: Pool, pools: Pools, broker: ReturnType<typeof makeBroker>;
beforeAll(async () => {
  p = await provision("agg"); admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin); await applyConfig(admin, cfg);
  // seed known values via admin (superuser) directly into the synth base table
  await admin.query(`insert into data_synth.salaries (id, job_title, base_salary, effective_date) values
    (gen_random_uuid(),'Senior Accountant',100000,'2021-01-01'),
    (gen_random_uuid(),'Senior Accountant',120000,'2022-01-01'),
    (gen_random_uuid(),'Analyst',80000,'2021-01-01')`);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  broker = makeBroker(pools, cfg);
});
afterAll(async () => { await admin.end(); await pools.end(); await p.end(); });

it("avg over granted base_salary with groupBy + filter returns correct value", async () => {
  await admin.query(`insert into app.grants (user_id,collection,allowed_fields,env,status)
    values ('a','salaries', array['job_title','base_salary','effective_date'],'dev','approved')`);
  const r = await broker.query({ userId: "a", env: "dev" }, {
    collection: "salaries", aggregate: [{ fn: "avg", field: "base_salary" }],
    groupBy: ["job_title"], filters: [{ field: "job_title", op: "eq", value: "Senior Accountant" }],
  });
  expect(r.ok).toBe(true);
  if (r.ok) expect(Number(r.documents[0].avg_base_salary)).toBe(110000);
});

it("aggregate on a non-granted field → field_denied (aggregate/groupBy/filter positions)", async () => {
  await admin.query(`insert into app.grants (user_id,collection,allowed_fields,env,status)
    values ('b','salaries', array['job_title','id'],'dev','approved')`);
  const inAgg = await broker.query({ userId: "b", env: "dev" },
    { collection: "salaries", aggregate: [{ fn: "avg", field: "base_salary" }], groupBy: ["job_title"] });
  const inGroup = await broker.query({ userId: "b", env: "dev" },
    { collection: "salaries", aggregate: [{ fn: "count", field: "id" }], groupBy: ["base_salary"] });
  const inFilter = await broker.query({ userId: "b", env: "dev" },
    { collection: "salaries", aggregate: [{ fn: "count", field: "id" }],
      filters: [{ field: "base_salary", op: "gt", value: 1 }] });
  for (const r of [inAgg, inGroup, inFilter]) { expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe("field_denied"); }
});

it("aggregate combined with fields → invalid_intent", async () => {
  const r = await broker.query({ userId: "a", env: "dev" },
    { collection: "salaries", fields: ["job_title"], aggregate: [{ fn: "avg", field: "base_salary" }] });
  expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe("invalid_intent");
});
