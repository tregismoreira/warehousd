import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, withOrg } from "../src/index";
import { loadConfig } from "../src/config/load";

let p: Provisioned, admin: Pool, imp: Pool;
const cfg = loadConfig(new URL("../../../examples/meridian", import.meta.url).pathname);

beforeAll(async () => {
  p = await provision("importrole");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  imp = new Pool({ connectionString: p.urls.imp });
}, 60_000);
afterAll(async () => { await admin.end(); await imp.end(); await p.end(); });

// The import role writes base tables directly, so RLS — not the view predicate — is what
// confines it to one org. Every insert therefore has to declare the org it is writing into,
// and the policy's WITH CHECK refuses a mismatch. `withOrg` is how the real import path does it.
const asOrg = (orgId: string, sql: string, params: unknown[] = []) =>
  withOrg(imp, orgId, (c) => c.query(sql, params));

describe("warehousd_import privileges", () => {
  it("can INSERT into a data_live base table", async () => {
    await expect(asOrg("default",
      `insert into data_live.departments (org_id, id, name) values ('default', gen_random_uuid(), 'Imported')`,
    )).resolves.toBeDefined();
  });

  it("cannot INSERT a row belonging to another org — RLS refuses, not the broker", async () => {
    await expect(asOrg("default",
      `insert into data_live.departments (org_id, id, name) values ('other', gen_random_uuid(), 'Smuggled')`,
    )).rejects.toThrow(/row-level security/i);
  });

  it("cannot SELECT from data_live — write-only means write-only", async () => {
    await expect(imp.query(`select * from data_live.departments`)).rejects.toThrow(/permission denied/i);
  });

  it("cannot SELECT the live view either", async () => {
    await expect(imp.query(`select * from data_live.v_people`)).rejects.toThrow(/permission denied/i);
  });

  it("cannot UPDATE or DELETE — an import appends, it never rewrites history", async () => {
    await expect(imp.query(`update data_live.departments set name='x'`)).rejects.toThrow(/permission denied/i);
    await expect(imp.query(`delete from data_live.departments`)).rejects.toThrow(/permission denied/i);
  });

  it("has no privileges at all on data_synth", async () => {
    await expect(imp.query(`select * from data_synth.people`)).rejects.toThrow(/permission denied/i);
    await expect(imp.query(
      `insert into data_synth.departments (id, name) values (gen_random_uuid(), 'x')`,
    )).rejects.toThrow(/permission denied/i);
  });

  it("cannot read app.grants — it is not a decision-making role", async () => {
    await expect(imp.query(`select * from app.grants`)).rejects.toThrow(/permission denied/i);
  });

  it("can insert multiple rows into the same table sequentially", async () => {
    await expect(asOrg("default",
      `insert into data_live.departments (org_id, id, name) values ('default', gen_random_uuid(), 'Sales')`,
    )).resolves.toBeDefined();
    await expect(asOrg("default",
      `insert into data_live.departments (org_id, id, name) values ('default', gen_random_uuid(), 'Engineering')`,
    )).resolves.toBeDefined();
  });
});

describe("the read roles gain nothing", () => {
  it("warehousd_live still cannot write", async () => {
    const live = new Pool({ connectionString: p.urls.live });
    await expect(live.query(
      `insert into data_live.departments (id, name) values (gen_random_uuid(), 'x')`,
    )).rejects.toThrow(/permission denied/i);
    await live.end();
  });

  it("warehousd_dev still cannot see data_live", async () => {
    const dev = new Pool({ connectionString: p.urls.dev });
    await expect(dev.query(`select * from data_live.v_people`)).rejects.toThrow(/permission denied/i);
    await dev.end();
  });
});
