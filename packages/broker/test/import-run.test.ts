import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import {
  createAppSchema,
  applyConfig,
  createPools,
  DEFAULT_WORKSPACE_ID,
  type Pools,
} from "../src/index";
import { importCollection } from "../src/import/run";
import { syncDatasetTerms } from "../src/taxonomy";
import { loadConfig } from "../src/config/load";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";

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

// Narrow to the success arm, naming the refusal when there is one. `expect(r.ok).toBe(true)`
// reports "expected false to be true", which is the one thing about the failure you already knew.
type Imported = Extract<Awaited<ReturnType<typeof importCollection>>, { ok: true }>;
function assertImported(r: Awaited<ReturnType<typeof importCollection>>): asserts r is Imported {
  if (!r.ok)
    throw new Error(
      `expected the import to succeed, got ${r.reason}` +
        (r.errors?.length ? `: ${JSON.stringify(r.errors.slice(0, 5))}` : ""),
    );
}

describe("importCollection", () => {
  it("imports a CSV into data_live and reports the row count", async () => {
    const before = await liveCount("departments");
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "csv",
      text: `id,name\n${U(1)},Robotics\n${U(2)},Finance`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r).toMatchObject({ mode: "append", dryRun: false, inserted: 2, updated: 0, deleted: 0 });
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
    expect(ev.rows[0].intent).toMatchObject({
      op: "import:append",
      format: "csv",
      rows: 1,
      inserted: 1,
    });
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
      { ...cfg, audit: { ...cfg.audit, enabled: false } },
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

// Update and delete, and the property that makes them safe: neither rewrites nor removes a
// stored row. Everything below asserts against the BASE table through the admin pool, because
// the view deliberately hides exactly what these tests are checking is still there.
describe("importCollection: upsert and delete write revisions", () => {
  // Each test owns its ids so the file's tests stay order-independent.
  const D = (n: number) => `0000d00${n}-0000-4000-8000-000000000000`.slice(-36);

  const revs = async (id: string) =>
    (
      await admin.query(
        `select _rev_seq, _rev_op, _rev_status, _current, name
         from data_live.departments where id=$1 order by _rev_seq`,
        [id],
      )
    ).rows;
  // What a reader would see: the view, not the table.
  const visible = async (id: string) =>
    (await admin.query(`select name from data_live.v_departments where id=$1`, [id])).rows;

  beforeAll(async () => {
    // The view filters on the workspace GUC, which is unset on a bare admin connection.
    await admin.query(`select set_config('warehousd.workspace_id', 'default', false)`);
  });

  it("upsert creates a document that does not exist yet", async () => {
    const r = await importCollection(
      pools,
      cfg,
      "ana",
      "departments",
      { format: "csv", text: `id,name\n${D(1)},Fresh` },
      { mode: "upsert" },
    );
    assertImported(r);
    expect(r).toMatchObject({ mode: "upsert", inserted: 1, updated: 0, deleted: 0 });
    expect(await revs(D(1))).toMatchObject([
      { _rev_seq: "1", _rev_op: "create", _current: true, name: "Fresh" },
    ]);
  });

  it("upsert revises a document that does, keeping the superseded revision", async () => {
    await importCollection(
      pools,
      cfg,
      "ana",
      "departments",
      { format: "csv", text: `id,name\n${D(2)},Before` },
      { mode: "append" },
    );
    const r = await importCollection(
      pools,
      cfg,
      "ana",
      "departments",
      { format: "csv", text: `id,name\n${D(2)},After` },
      { mode: "upsert" },
    );
    assertImported(r);
    expect(r).toMatchObject({ inserted: 0, updated: 1 });

    // Two rows, not one: the first is history, and it still holds the value it held.
    expect(await revs(D(2))).toMatchObject([
      { _rev_seq: "1", _rev_op: "create", _current: false, name: "Before" },
      { _rev_seq: "2", _rev_op: "update", _current: true, name: "After" },
    ]);
    expect(await visible(D(2))).toMatchObject([{ name: "After" }]);
  });

  it("upsert carries untouched columns forward rather than blanking them", async () => {
    await importCollection(
      pools,
      cfg,
      "ana",
      "people",
      {
        format: "csv",
        text: `id,full_name,email,department_id,home_address,phone\n${D(3)},Ada,ada@x.com,${U(1)},1 Main St,555-1`,
      },
      { mode: "append" },
    );
    // Only the email column. Everything else must survive — this is the difference between an
    // upsert and a replace, and getting it wrong silently destroys columns the file omitted.
    const r = await importCollection(
      pools,
      cfg,
      "ana",
      "people",
      { format: "csv", text: `id,email\n${D(3)},ada@new.com` },
      { mode: "upsert" },
    );
    assertImported(r);
    const row = await admin.query(
      `select full_name, email, home_address, phone from data_live.people where id=$1 and _current`,
      [D(3)],
    );
    expect(row.rows[0]).toMatchObject({
      full_name: "Ada",
      email: "ada@new.com",
      home_address: "1 Main St",
      phone: "555-1",
    });
  });

  it("delete retires a document from the view while its history survives in full", async () => {
    await importCollection(
      pools,
      cfg,
      "ana",
      "departments",
      { format: "csv", text: `id,name\n${D(4)},Doomed` },
      { mode: "append" },
    );
    const r = await importCollection(
      pools,
      cfg,
      "ana",
      "departments",
      { format: "csv", text: `id\n${D(4)}` },
      { mode: "delete" },
    );
    assertImported(r);
    expect(r).toMatchObject({ mode: "delete", deleted: 1 });

    expect(await visible(D(4))).toHaveLength(0);
    // Nothing was erased: both revisions are on the table, and the original still holds its value.
    expect(await revs(D(4))).toMatchObject([
      { _rev_seq: "1", _rev_op: "create", _current: false, name: "Doomed" },
      { _rev_seq: "2", _rev_op: "delete", _current: true, name: "Doomed" },
    ]);
  });

  it("delete takes a pk-only file — no other column has to be supplied", async () => {
    // people has several non-nullable columns. A delete file carrying only the pk is the
    // normal case, and validation must not hold it to the shape an append needs.
    await importCollection(
      pools,
      cfg,
      "ana",
      "people",
      {
        format: "csv",
        text: `id,full_name,email,department_id,home_address,phone\n${D(5)},Gone,g@x.com,${U(1)},2 Main St,555-2`,
      },
      { mode: "append" },
    );
    const r = await importCollection(
      pools,
      cfg,
      "ana",
      "people",
      { format: "csv", text: `id\n${D(5)}` },
      { mode: "delete" },
    );
    assertImported(r);
  });

  it("refuses a whole delete file when any row names a document that is not there", async () => {
    await importCollection(
      pools,
      cfg,
      "ana",
      "departments",
      { format: "csv", text: `id,name\n${D(6)},Real` },
      { mode: "append" },
    );
    const r = await importCollection(
      pools,
      cfg,
      "ana",
      "departments",
      { format: "csv", text: `id\n${D(6)}\n${D(7)}` },
      { mode: "delete" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("validation_failed");
    expect(r.errors?.[0]).toMatchObject({ row: 1, reason: "not_found" });
    // All-or-nothing: the row that DID match is still there.
    expect(await visible(D(6))).toHaveLength(1);
  });

  it("refuses an upsert-create that omits a required column", async () => {
    // The pk is all upsert validation demands, so this row passes validation and is caught
    // where it has to be: at the point the row turns out to be a create rather than an edit.
    const r = await importCollection(
      pools,
      cfg,
      "ana",
      "people",
      { format: "csv", text: `id,email\n${D(8)},nobody@x.com` },
      { mode: "upsert" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("validation_failed");
    expect(r.errors?.map((e) => e.column)).toContain("full_name");
    const stored = await admin.query(`select 1 from data_live.people where id=$1`, [D(8)]);
    expect(stored.rowCount).toBe(0);
  });

  it("refuses upsert and delete on a collection with no primary key", async () => {
    // Nothing addresses a document without one, so both modes are structurally unavailable.
    const noPk = ConfigSchema.parse({
      project: "t",
      server: { port: 1 },
      collections: {
        readings: {
          description: "d",
          fields: { label: { type: "text", posture: "allow" } },
        },
      },
    });
    for (const mode of ["upsert", "delete"] as const) {
      const r = await importCollection(
        pools,
        noPk,
        "ana",
        "readings",
        { format: "csv", text: `label\nx` },
        { mode },
      );
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.reason).toBe("no_primary_key");
    }
  });

  it("refuses an unknown mode outright", async () => {
    const r = await importCollection(
      pools,
      cfg,
      "ana",
      "departments",
      { format: "csv", text: `id,name\n${D(9)},X` },
      { mode: "replace" as never },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("unknown_mode");
  });

  it("records every mode's counts in the audit intent, and never a value", async () => {
    await importCollection(
      pools,
      cfg,
      "ana",
      "departments",
      { format: "csv", text: `id,name\n${D(10)},AuditSubject` },
      { mode: "append" },
    );
    const r = await importCollection(
      pools,
      cfg,
      "ana",
      "departments",
      { format: "csv", text: `id,name\n${D(10)},SecretRenamed` },
      { mode: "upsert" },
    );
    if (!r.ok) throw new Error("unreachable");
    const ev = await admin.query(`select intent from app.audit_events where id=$1`, [r.auditId]);
    expect(ev.rows[0].intent).toMatchObject({ op: "import:upsert", updated: 1, inserted: 0 });
    expect(JSON.stringify(ev.rows[0].intent)).not.toContain("SecretRenamed");
  });

  it("writes one change feed entry per row, through the app pool", async () => {
    await importCollection(
      pools,
      cfg,
      "ana",
      "departments",
      { format: "csv", text: `id,name\n${D(11)},Feed1\n${D(12)},Feed2` },
      { mode: "append" },
    );
    const feed = await admin.query(
      `select document_id, op, by from app.change_log
       where collection='departments' and document_id = any($1)`,
      [[D(11), D(12)]],
    );
    expect(feed.rowCount).toBe(2);
    expect(feed.rows.every((r) => r.op === "create" && r.by === "ana")).toBe(true);
  });
});

describe("importCollection: dry run", () => {
  const P = (n: number) => `0000e00${n}-0000-4000-8000-000000000000`.slice(-36);

  it("reports what would happen and writes nothing at all", async () => {
    await importCollection(
      pools,
      cfg,
      "ana",
      "departments",
      { format: "csv", text: `id,name\n${P(1)},Existing` },
      { mode: "append" },
    );
    const before = await liveCount("departments");
    const auditBefore = Number(
      (await admin.query(`select count(*)::int as n from app.audit_events`)).rows[0].n,
    );

    // One row that exists and one that does not: the counts are the whole point of a preview.
    const r = await importCollection(
      pools,
      cfg,
      "ana",
      "departments",
      { format: "csv", text: `id,name\n${P(1)},Revised\n${P(2)},Brand New` },
      { mode: "upsert", dryRun: true },
    );
    assertImported(r);
    expect(r).toMatchObject({ dryRun: true, inserted: 1, updated: 1 });

    // Rolled back: no new rows, and the existing document still holds its original value.
    expect(await liveCount("departments")).toBe(before);
    const row = await admin.query(
      `select name from data_live.departments where id=$1 and _current`,
      [P(1)],
    );
    expect(row.rows[0].name).toBe("Existing");
    // The audit row is NOT rolled back — it goes through the app pool, which is a different
    // connection and a different transaction. A preview is a decision and gets recorded.
    const auditAfter = Number(
      (await admin.query(`select count(*)::int as n from app.audit_events`)).rows[0].n,
    );
    expect(auditAfter).toBe(auditBefore + 1);
  });

  it("surfaces per-row problems without writing, exactly as the real run would", async () => {
    const before = await liveCount("departments");
    const r = await importCollection(
      pools,
      cfg,
      "ana",
      "departments",
      { format: "csv", text: `id\n${P(3)}` },
      { mode: "delete", dryRun: true },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors?.[0]).toMatchObject({ reason: "not_found" });
    expect(await liveCount("departments")).toBe(before);
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
      await syncDatasetTerms(dAdmin, dsCfg, "live", DEFAULT_WORKSPACE_ID);
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

// §P8. An import is not a grant decision, but it is the single write path into data_live and it
// belongs in the same trail — so it has to reach the same DESTINATION. While this path called
// `writeAudit` directly it always landed in `app.audit_events`, which meant a deployment
// forwarding its trail to a SIEM silently lost the highest-volume event it has.
describe("the import audit row goes to the configured sink", () => {
  // The parsed harbor config with one field changed. Re-parsing the YAML would only re-prove
  // that the schema works; what is under test is where the row goes.
  const sunk: WarehousdConfig = { ...cfg, audit: { enabled: true, sink: "stdout-json" } };

  it("writes the decision to the sink and not to app.audit_events", async () => {
    const before = await admin.query<{ n: string }>(
      `select count(*)::text as n from app.audit_events where user_id='sunk_importer'`,
    );

    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => {
      written.push(String(s));
      return true;
    }) as typeof process.stdout.write);
    let r: Awaited<ReturnType<typeof importCollection>>;
    try {
      r = await importCollection(pools, sunk, "sunk_importer", "departments", {
        format: "csv",
        text: `id,name\n${U(40)},Sunk`,
      });
    } finally {
      spy.mockRestore();
    }
    assertImported(r);

    const line = written.find((l) => l.includes("warehousd.audit"));
    expect(line).toBeDefined();
    const event = JSON.parse(line!) as {
      id: string;
      outcome: string;
      collection: string;
      intent: { op: string };
    };
    expect(event.id).toBe(r.auditId);
    expect(event).toMatchObject({ outcome: "allowed", collection: "departments" });
    expect(event.intent.op).toBe("import:append");

    const after = await admin.query<{ n: string }>(
      `select count(*)::text as n from app.audit_events where user_id='sunk_importer'`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("carries no cell value into the sink's payload", async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => {
      written.push(String(s));
      return true;
    }) as typeof process.stdout.write);
    try {
      await importCollection(pools, sunk, "sunk_importer", "departments", {
        format: "csv",
        text: `id,name\n${U(41)},CANARY-7f3a9b`,
      });
    } finally {
      spy.mockRestore();
    }
    // A forwarded event travels further than a table does — the whole point of a webhook sink —
    // so "column names and counts only" has to hold on this path too.
    expect(written.join("")).not.toContain("CANARY-7f3a9b");
  });
});

// Where the import came from. A console import and one from CI are the same write path and a
// different governance question, and only the audit row can tell them apart.
describe("via", () => {
  it("defaults to session and records what the caller names", async () => {
    const fromConsole = await importCollection(pools, cfg, "ana", "departments", {
      format: "csv",
      text: `id,name\n${U(42)},Console`,
    });
    assertImported(fromConsole);
    const fromCli = await importCollection(
      pools,
      cfg,
      "ana",
      "departments",
      { format: "csv", text: `id,name\n${U(43)},Robot` },
      { via: "cli" },
    );
    assertImported(fromCli);

    const rows = await admin.query<{ id: string; via: string }>(
      `select id, via from app.audit_events where id = any($1)`,
      [[fromConsole.auditId, fromCli.auditId]],
    );
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.via]));
    expect(byId[fromConsole.auditId!]).toBe("session");
    expect(byId[fromCli.auditId!]).toBe("cli");
  });
});
