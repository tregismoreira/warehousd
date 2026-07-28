import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, type Pools } from "../src/index";
import { importCollection } from "../src/import/run";
import { loadConfig } from "../src/config/load";

let p: Provisioned, admin: Pool, pools: Pools;
const cfg = loadConfig(new URL("../../../examples/meridian", import.meta.url).pathname);
const U = (n: number) => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);

beforeAll(async () => {
  p = await provision("importrun");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live, imp: p.urls.imp });
}, 60_000);
afterAll(async () => { await admin.end(); await pools.end(); await p.end(); });

const liveCount = async (t: string) =>
  Number((await admin.query(`select count(*)::int as n from data_live.${t}`)).rows[0].n);

describe("importCollection", () => {
  it("imports a CSV into data_live and reports the row count", async () => {
    const before = await liveCount("departments");
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "csv",
      text: `id,name\n${U(1)},Robotics\n${U(2)},Finance`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.imported).toBe(2);
    expect(await liveCount("departments")).toBe(before + 2);
  });

  it("imports JSON with the same result", async () => {
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "json",
      text: JSON.stringify([{ id: U(3), name: "Legal" }]),
    });
    expect(r.ok).toBe(true);
  });

  it("writes data_live and never data_synth", async () => {
    const synthBefore = Number(
      (await admin.query(`select count(*)::int as n from data_synth.departments`)).rows[0].n);
    await importCollection(pools, cfg, "ana", "departments", {
      format: "csv", text: `id,name\n${U(4)},Ops`,
    });
    const synthAfter = Number(
      (await admin.query(`select count(*)::int as n from data_synth.departments`)).rows[0].n);
    expect(synthAfter).toBe(synthBefore);
  });

  it("is atomic — one bad row imports nothing", async () => {
    const before = await liveCount("departments");
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "csv", text: `id,name\n${U(5)},Good\nnot-a-uuid,Bad`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("validation_failed");
    expect(await liveCount("departments")).toBe(before);
  });

  it("refuses a duplicate primary key against existing data without overwriting", async () => {
    await importCollection(pools, cfg, "ana", "departments", {
      format: "csv", text: `id,name\n${U(6)},Original`,
    });
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "csv", text: `id,name\n${U(6)},Overwritten`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("constraint_violation");
    const row = await admin.query(`select name from data_live.departments where id=$1`, [U(6)]);
    expect(row.rows[0].name).toBe("Original");
  });

  it("refuses a file collection", async () => {
    const r = await importCollection(pools, cfg, "ana", "policies", {
      format: "json", text: `[{"title":"x"}]`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("validation_failed");
  });

  it("refuses cleanly when no import pool is configured", async () => {
    const noImp = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
    const r = await importCollection(noImp, cfg, "ana", "departments", {
      format: "csv", text: `id,name\n${U(7)},X`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("import_not_configured");
    await noImp.end();
  });

  it("refuses unparseable input without throwing", async () => {
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "json", text: "{oops",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("parse_failed");
  });

  it("audits a successful import", async () => {
    const r = await importCollection(pools, cfg, "ana", "metrics", {
      format: "csv",
      text: `id,date,revenue,active_customers,region\n${U(8)},2026-01-01,100.5,10,emea`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const ev = await admin.query(`select * from app.audit_events where id=$1`, [r.auditId]);
    expect(ev.rows[0]).toMatchObject({
      user_id: "ana", env: "live", collection: "metrics", outcome: "allowed",
    });
    expect(ev.rows[0].intent).toMatchObject({ op: "import", format: "csv", rows: 1 });
  });

  it("audits a refused import with the reason", async () => {
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "csv", text: `id,name\nbad,X`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    const ev = await admin.query(`select * from app.audit_events where id=$1`, [r.auditId]);
    expect(ev.rows[0]).toMatchObject({
      user_id: "ana", env: "live", collection: "departments",
      outcome: "refused", reason: "validation_failed",
    });
  });

  it("never records imported values in the audit intent", async () => {
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "csv", text: `id,name\n${U(9)},TopSecretDepartmentName`,
    });
    if (!r.ok) throw new Error("unreachable");
    const ev = await admin.query(`select intent from app.audit_events where id=$1`, [r.auditId]);
    expect(JSON.stringify(ev.rows[0].intent)).not.toContain("TopSecretDepartmentName");
  });

  it("imports a posture:deny column so real sensitive data can land and stay unreadable", async () => {
    const r = await importCollection(pools, cfg, "ana", "people", {
      format: "csv",
      text: `id,full_name,email,department_id,home_address,phone\n${U(10)},Real Person,rp@x.com,${U(1)},1 Main St,555-0100`,
    });
    expect(r.ok).toBe(true);
    const stored = await admin.query(`select home_address from data_live.people where id=$1`, [U(10)]);
    expect(stored.rows[0].home_address).toBe("1 Main St");
  });
});
