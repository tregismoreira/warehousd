import { it, expect, beforeAll, afterAll, vi } from "vitest";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { createPools, type Pools } from "../src/db/pools";
import { makeBroker } from "../src/broker";
import { loadConfig } from "../src/config/load";
import { DENIED_CANARY, SSN_CANARY } from "./fixtures/canaries";
import type { QueryIntent } from "../src/types";

// NOTE: depends on examples/meridian, excluded from mvp/ until Task 12 recreates it — expected to fail until then.

const cfg = loadConfig(join(__dirname, "../../../examples/meridian"));
const probes = JSON.parse(readFileSync(join(__dirname, "fixtures/probes.json"), "utf8")) as
  { name: string; intent: QueryIntent; expect: "allowed" | "refused" }[];

let p: Provisioned, admin: Pool, pools: Pools, logs: string[] = [];
beforeAll(async () => {
  p = await provision("probe"); admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin); await applyConfig(admin, cfg);
  // plant canaries directly into denied columns
  const dep = (await admin.query(`insert into data_synth.departments (id,name) values (gen_random_uuid(),'Fin') returning id`)).rows[0].id;
  const person = (await admin.query(
    `insert into data_synth.people (id,full_name,email,department_id,home_address,phone)
     values (gen_random_uuid(),'P','p@x', $1, $2, '555') returning id`, [dep, DENIED_CANARY])).rows[0].id;
  await admin.query(
    `insert into data_synth.salaries (id,person_id,job_title,base_salary,currency,effective_date,ssn)
     values (gen_random_uuid(), $1, 'Senior Accountant', 100000,'USD','2023-01-01',$2)`, [person, SSN_CANARY]);
  // grant priya EVERYTHING grantable so the ONLY thing blocking canaries is posture, not missing grant
  for (const [c, fields] of [
    ["people", ["id","full_name","email","department_name","department_id"]],
    ["salaries", ["id","person_id","job_title","base_salary","currency","effective_date"]],
  ] as const)
    await admin.query(`insert into app.grants (user_id,collection,allowed_fields,env,status)
      values ('priya',$1,$2,'dev','approved')`, [c, fields]);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { logs.push(a.join(" ")); });
});
afterAll(async () => { vi.restoreAllMocks(); await admin.end(); await pools.end(); await p.end(); });

it("no probe leaks any denied canary; outcomes match expectations", async () => {
  const broker = makeBroker(pools, cfg);
  for (const probe of probes) {
    const r = await broker.query({ userId: "priya", env: "dev" }, probe.intent);
    const outcome = r.ok ? "allowed" : "refused";
    expect(outcome, `probe "${probe.name}"`).toBe(probe.expect);
    const payload = JSON.stringify(r);
    for (const canary of [DENIED_CANARY, SSN_CANARY]) {
      expect(payload.includes(canary), `canary in response of "${probe.name}"`).toBe(false);
    }
  }
  // no canary reached any captured log line
  for (const canary of [DENIED_CANARY, SSN_CANARY])
    expect(logs.join("\n").includes(canary)).toBe(false);
  // the table still exists (sql-injection probe did not drop it)
  const still = await admin.query(`select count(*)::int c from data_synth.people`);
  expect(still.rows[0].c).toBeGreaterThan(0);
});
