import type { Pool } from "pg";
import { LIVE_ONLY_CANARY } from "../../../packages/broker/test/fixtures/canaries";

// Minimal, deterministic live seed. Distinct values from synth so env separation is provable.
export async function seedLive(admin: Pool): Promise<void> {
  await admin.query(`truncate
    data_live.clients, data_live.people, data_live.departments, data_live.salaries,
    data_live.announcements, data_live.metrics, data_live.matters, data_live.time_entries,
    data_live.invoices, data_live.trust_accounts, data_live.expenses, data_live.vendors,
    data_live.conflict_checks, data_live.court_deadlines, data_live.performance_reviews,
    data_live.pto_requests cascade`);

  const dep = (
    await admin.query(
      `insert into data_live.departments (id,name) values (gen_random_uuid(),'Finance') returning id`,
    )
  ).rows[0].id;
  const person = (
    await admin.query(
      `insert into data_live.people (id, full_name, email, department_id, home_address, phone)
     values (gen_random_uuid(), $1, 'real.person@harbor.live', $2, $3, '555-0100') returning id`,
      [`REAL ${LIVE_ONLY_CANARY}`, dep, LIVE_ONLY_CANARY],
    )
  ).rows[0].id;
  await admin.query(
    `insert into data_live.salaries (id, person_id, job_title, base_salary, currency, effective_date, ssn)
     values (gen_random_uuid(), $1, 'Senior Accountant', 199999, 'USD', '2024-01-01', $2)`,
    [person, LIVE_ONLY_CANARY],
  );

  // Fixed client numbers — case-files-live/ documents reference their slugified form
  // (c-9001, c-9002) directly, since vocabulary terms are env-scoped: the `client`
  // vocabulary's live term set comes only from data_live.clients rows.
  const client1 = (
    await admin.query(
      `insert into data_live.clients (id, client_number, name, industry, status, onboarded_at, primary_contact_email)
     values (gen_random_uuid(), 'C-9001', 'Beacon Manufacturing', 'Manufacturing', 'active', now(), 'contact@beaconmfg.example')
     returning id`,
    )
  ).rows[0].id;
  const client2 = (
    await admin.query(
      `insert into data_live.clients (id, client_number, name, industry, status, onboarded_at, primary_contact_email)
     values (gen_random_uuid(), 'C-9002', 'Ridgeline Property Group', 'Real Estate', 'active', now(), 'contact@ridgelinepg.example')
     returning id`,
    )
  ).rows[0].id;

  await admin.query(
    `insert into data_live.matters (id, matter_number, client_id, responsible_attorney_id, originating_attorney_id)
     values (gen_random_uuid(), 'M-2025-9001', $1, $2, $2)`,
    [client1, person],
  );
  await admin.query(
    `insert into data_live.matters (id, matter_number, client_id, responsible_attorney_id, originating_attorney_id)
     values (gen_random_uuid(), 'M-2025-9002', $1, $2, $2)`,
    [client2, person],
  );
}
