import type { Pool } from "pg";
import { LIVE_ONLY_CANARY } from "../../../packages/broker/test/fixtures/canaries";

// Minimal, deterministic live seed. Distinct values from synth so env separation is provable.
export async function seedLive(admin: Pool): Promise<void> {
  await admin.query(`truncate data_live.departments, data_live.people, data_live.salaries,
    data_live.documents, data_live.metrics cascade`);
  const dep = (await admin.query(
    `insert into data_live.departments (id,name) values (gen_random_uuid(),'Finance') returning id`)).rows[0].id;
  const person = (await admin.query(
    `insert into data_live.people (id, full_name, email, department_id, home_address, phone)
     values (gen_random_uuid(), $1, 'real.person@meridian.live', $2, $3, '555-0100') returning id`,
    [`REAL ${LIVE_ONLY_CANARY}`, dep, LIVE_ONLY_CANARY])).rows[0].id;
  await admin.query(
    `insert into data_live.salaries (id, person_id, job_title, base_salary, currency, effective_date, ssn)
     values (gen_random_uuid(), $1, 'Senior Accountant', 199999, 'USD', '2024-01-01', $2)`,
    [person, LIVE_ONLY_CANARY]);
}
