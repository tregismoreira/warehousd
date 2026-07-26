import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, makeBroker, createPools, type Pools } from "../src/index";
import { importCollection } from "../src/import/run";
import { loadConfig } from "../src/config/load";
import { IMPORT_CANARY, IMPORT_DENIED_CANARY } from "./fixtures/canaries";

let p: Provisioned, admin: Pool, pools: Pools, broker: ReturnType<typeof makeBroker>;
const cfg = loadConfig(new URL("../../../examples/meridian", import.meta.url).pathname);
const PERSON = "9a000001-0000-4000-8000-000000000001";
const DEPT = "8b000001-0000-4000-8000-000000000001";
const ctx = { userId: "mia", env: "live" as const };

beforeAll(async () => {
  p = await provision("importprobe");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live, imp: p.urls.imp });
  broker = makeBroker(pools, cfg);

  // Import a department first to establish FK
  const depR = await importCollection(pools, cfg, "ana", "departments", {
    format: "csv",
    text: `id,name\n${DEPT},Test Dept`,
  });
  if (!depR.ok) throw new Error(`fixture department import failed: ${depR.reason}`);

  // Plant the canaries through the real import path — not a direct INSERT. If the import
  // path itself is the leak, this test must see it.
  const r = await importCollection(pools, cfg, "ana", "people", {
    format: "csv",
    text: `id,full_name,email,department_id,home_address,phone\n` +
          `${PERSON},${IMPORT_CANARY},canary@x.test,${DEPT},${IMPORT_DENIED_CANARY},555-0000`,
  });
  if (!r.ok) throw new Error(`fixture import failed: ${r.reason}`);

  // Mia gets a live grant that excludes home_address and phone (both posture: deny anyway).
  await admin.query(
    `insert into app.grants (user_id,collection,env,status,allowed_fields,expires_at)
     values ('mia','people','live','approved',
             array['id','full_name','email'], now() + interval '1 day')`);
}, 60_000);
afterAll(async () => { await admin.end(); await pools.end(); await p.end(); });

const probes: { name: string; intent: any; expect: string; surface?: string }[] =
  JSON.parse(readFileSync(new URL("./fixtures/probes.json", import.meta.url), "utf8"));

describe("imported live data is subject to the same enforcement as seeded data", () => {
  it("a granted field imported through the admin path is readable", async () => {
    const r = await broker.query(ctx, { collection: "people", fields: ["full_name"] });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(JSON.stringify(r.documents)).toContain(IMPORT_CANARY);
  });

  it("the imported posture:deny value is absent from an unfielded query", async () => {
    const r = await broker.query(ctx, { collection: "people" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    for (const row of r.documents) expect("home_address" in row).toBe(false);
    expect(JSON.stringify(r.documents)).not.toContain(IMPORT_DENIED_CANARY);
  });

  it("asking for the imported denied field is refused, and the refusal says nothing", async () => {
    const r = await broker.query(ctx, { collection: "people", fields: ["home_address"] });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(IMPORT_DENIED_CANARY);
  });

  it("filtering on the imported denied field is refused", async () => {
    const r = await broker.query(ctx, {
      collection: "people", fields: ["id"],
      filters: [{ field: "home_address", op: "eq", value: IMPORT_DENIED_CANARY }],
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(IMPORT_DENIED_CANARY);
  });

  it("the full hostile-intent suite leaks no imported denied value", async () => {
    for (const probe of probes) {
      // Skip probes not applicable to the people collection (e.g., searchDocuments surface or collection-specific fields)
      if (probe.surface === "searchDocuments") continue;
      if (probe.intent.collection && probe.intent.collection !== "people") continue;

      const intent = { ...probe.intent, collection: "people" };
      let out: unknown;
      try { out = await broker.query(ctx, intent as never); }
      catch (e) { out = { error: String(e) }; }
      expect(JSON.stringify(out), `probe: ${probe.name}`).not.toContain(IMPORT_DENIED_CANARY);
    }
  });

  it("a dev-context caller sees no imported live value at all", async () => {
    await admin.query(
      `insert into app.grants (user_id,collection,env,status,allowed_fields)
       values ('mia','people','dev','approved', array['id','full_name','email'])`);
    const r = await broker.query({ userId: "mia", env: "dev" }, { collection: "people" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const body = JSON.stringify(r.documents);
    expect(body).not.toContain(IMPORT_CANARY);
    expect(body).not.toContain(IMPORT_DENIED_CANARY);
  });

  it("every probe above is audited", async () => {
    // Count applicable probes: non-searchDocuments that target people (or have no collection, which we override to people)
    const applicableProbes = probes.filter(p => {
      if (p.surface === "searchDocuments") return false;
      if (p.intent.collection && p.intent.collection !== "people") return false;
      return true;
    }).length;
    // 4 earlier queries + applicableProbes + 1 dev query
    const expectedMinimum = 4 + applicableProbes + 1;
    const n = await admin.query(
      `select count(*)::int as n from app.audit_events where user_id='mia' and collection='people'`);
    expect(n.rows[0].n).toBeGreaterThanOrEqual(expectedMinimum);
  });
});
