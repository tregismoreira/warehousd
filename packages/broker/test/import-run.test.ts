import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, type Pools } from "../src/index";
import { importCollection } from "../src/import/run";
import { syncDatasetTerms } from "../src/taxonomy";
import { loadConfig } from "../src/config/load";
import { ConfigSchema } from "../src/config/schema";

let p: Provisioned, admin: Pool, pools: Pools;
const cfg = loadConfig(new URL("../../../examples/harbor", import.meta.url).pathname);
const U = (n: number) => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);

beforeAll(async () => {
  p = await provision("importrun");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live, imp: p.urls.imp });
}, 60_000);
afterAll(async () => {
  await admin.end();
  await pools.end();
  await p.end();
});

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
      (await admin.query(`select count(*)::int as n from data_synth.departments`)).rows[0].n,
    );
    await importCollection(pools, cfg, "ana", "departments", {
      format: "csv",
      text: `id,name\n${U(4)},Ops`,
    });
    const synthAfter = Number(
      (await admin.query(`select count(*)::int as n from data_synth.departments`)).rows[0].n,
    );
    expect(synthAfter).toBe(synthBefore);
  });

  it("is atomic — one bad row imports nothing", async () => {
    const before = await liveCount("departments");
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "csv",
      text: `id,name\n${U(5)},Good\nnot-a-uuid,Bad`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("validation_failed");
    expect(await liveCount("departments")).toBe(before);
  });

  it("refuses a duplicate primary key against existing data without overwriting", async () => {
    await importCollection(pools, cfg, "ana", "departments", {
      format: "csv",
      text: `id,name\n${U(6)},Original`,
    });
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "csv",
      text: `id,name\n${U(6)},Overwritten`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("constraint_violation");
    const row = await admin.query(`select name from data_live.departments where id=$1`, [U(6)]);
    expect(row.rows[0].name).toBe("Original");
  });

  it("refuses a file collection", async () => {
    const r = await importCollection(pools, cfg, "ana", "policies", {
      format: "json",
      text: `[{"title":"x"}]`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("validation_failed");
  });

  it("refuses cleanly when no import pool is configured", async () => {
    const noImp = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
    const r = await importCollection(noImp, cfg, "ana", "departments", {
      format: "csv",
      text: `id,name\n${U(7)},X`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("import_not_configured");
    await noImp.end();
  });

  it("refuses unparseable input without throwing", async () => {
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "json",
      text: "{oops",
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
      user_id: "ana",
      env: "live",
      collection: "metrics",
      outcome: "allowed",
    });
    expect(ev.rows[0].intent).toMatchObject({ op: "import", format: "csv", rows: 1 });
  });

  it("audits a refused import with the reason", async () => {
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "csv",
      text: `id,name\nbad,X`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    const ev = await admin.query(`select * from app.audit_events where id=$1`, [r.auditId]);
    expect(ev.rows[0]).toMatchObject({
      user_id: "ana",
      env: "live",
      collection: "departments",
      outcome: "refused",
      reason: "validation_failed",
    });
  });

  // The import path writes its own audit row rather than going through the broker's audit writer,
  // so `audit.enabled: false` has to be honoured here separately — otherwise an environment that
  // looks unaudited still accumulates a row per import.
  it("writes no audit row when audit.enabled is false", async () => {
    const before = Number(
      (await admin.query(`select count(*)::int as n from app.audit_events`)).rows[0].n,
    );
    const r = await importCollection(
      pools,
      { ...cfg, audit: { enabled: false } },
      "ana",
      "departments",
      { format: "csv", text: `id,name\n${U(19)},Unaudited` },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.auditId).toBeNull();
    const after = Number(
      (await admin.query(`select count(*)::int as n from app.audit_events`)).rows[0].n,
    );
    expect(after).toBe(before);
  });

  it("never records imported values in the audit intent", async () => {
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "csv",
      text: `id,name\n${U(9)},TopSecretDepartmentName`,
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
    const stored = await admin.query(`select home_address from data_live.people where id=$1`, [
      U(10),
    ]);
    expect(stored.rows[0].home_address).toBe("1 Main St");
  });
});

describe("importCollection: dataset-sourced vocabulary", () => {
  // Harbor binds `client` to a file collection, which import refuses outright. The capability
  // this exercises — scoping a dataset collection by a dataset-sourced vocabulary — needs its
  // own config and its own database.
  const dsCfg = ConfigSchema.parse({
    project: "t",
    server: { port: 1 },
    taxonomies: {
      client: {
        label: "Client",
        source: { collection: "clients", slug: "client_number", label: "name" },
      },
    },
    collections: {
      clients: {
        description: "d",
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          client_number: { type: "text", posture: "allow" },
          name: { type: "text", posture: "allow" },
        },
      },
      matters: {
        description: "d",
        taxonomies: ["client"],
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          matter_number: { type: "text", posture: "allow" },
        },
      },
    },
  });

  let dp: Provisioned, dAdmin: Pool, dPools: Pools;
  beforeAll(async () => {
    dp = await provision("importrun_dsvocab");
    dAdmin = new Pool({ connectionString: dp.urls.admin });
    await createAppSchema(dAdmin);
    await applyConfig(dAdmin, dsCfg);
    dPools = createPools({
      app: dp.urls.admin,
      dev: dp.urls.dev,
      live: dp.urls.live,
      imp: dp.urls.imp,
    });
    // The live term set comes from live rows, so the source collection is imported first —
    // importCollection syncs terms on commit.
    const r = await importCollection(dPools, dsCfg, "ana", "clients", {
      format: "csv",
      text: `id,client_number,name\n${U(1)},C-0001,Acme\n${U(2)},C-0002,Globex`,
    });
    expect(r.ok).toBe(true);
  }, 60_000);
  afterAll(async () => {
    await dAdmin.end();
    await dPools.end();
    await dp.end();
  });

  it("accepts a row naming a client that exists live", async () => {
    const r = await importCollection(dPools, dsCfg, "ana", "matters", {
      format: "csv",
      text: `id,matter_number,client\n${U(11)},M-1,c-0001`,
    });
    expect(r.ok).toBe(true);
    const stored = await dAdmin.query(`select client from data_live.matters where id=$1`, [U(11)]);
    expect(stored.rows[0].client).toBe("c-0001");
  });

  it("rejects a row naming a client that does not — unknown_term, not unvalidatable_term", async () => {
    const r = await importCollection(dPools, dsCfg, "ana", "matters", {
      format: "csv",
      text: `id,matter_number,client\n${U(12)},M-2,c-9999`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("validation_failed");
    expect(r.errors?.[0]).toMatchObject({ column: "client", reason: "unknown_term" });
    const stored = await dAdmin.query(`select 1 from data_live.matters where id=$1`, [U(12)]);
    expect(stored.rowCount).toBe(0);
  });

  it("refuses a vocabulary this stack never applied as unvalidatable_term", async () => {
    // The vocabulary row is gone, so loadTaxonomyBindings throws a plain Error — the terms
    // are genuinely unresolvable rather than temporarily unreachable.
    await dAdmin.query(`delete from app.terms`);
    await dAdmin.query(`delete from app.vocabularies where slug='client'`);
    try {
      const r = await importCollection(dPools, dsCfg, "ana", "matters", {
        format: "csv",
        text: `id,matter_number,client\n${U(13)},M-3,c-0001`,
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.reason).toBe("validation_failed");
      expect(r.errors?.[0]).toMatchObject({ column: "client", reason: "unvalidatable_term" });
    } finally {
      await applyConfig(dAdmin, dsCfg);
      await syncDatasetTerms(dAdmin, dsCfg, "live");
    }
  });

  it("refuses a broken app schema as taxonomy_unavailable, not as a config problem", async () => {
    // An outage must not be reported as an unvalidatable vocabulary: that sends an admin to
    // fix a config that was never wrong. `app.terms` is unreadable but the pool still works,
    // so the refusal is still audited — which is the case that distinguishes the two.
    await dAdmin.query(`alter table app.terms rename to terms_hidden`);
    try {
      const r = await importCollection(dPools, dsCfg, "ana", "matters", {
        format: "csv",
        text: `id,matter_number,client\n${U(14)},M-4,c-0001`,
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.reason).toBe("taxonomy_unavailable");
      expect(r.auditId).not.toBeNull();
      const ev = await dAdmin.query(`select * from app.audit_events where id=$1`, [r.auditId]);
      expect(ev.rows[0]).toMatchObject({ outcome: "refused", reason: "taxonomy_unavailable" });
      // Nothing was written: the refusal happens before the insert transaction opens.
      const stored = await dAdmin.query(`select 1 from data_live.matters where id=$1`, [U(14)]);
      expect(stored.rowCount).toBe(0);
    } finally {
      await dAdmin.query(`alter table app.terms_hidden rename to terms`);
    }
  });
});
