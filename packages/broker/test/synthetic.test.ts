import { describe, it, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { generateSynthetic } from "../src/synthetic/generate";
import { ConfigSchema } from "../src/config/schema";
import type { WarehousdConfig } from "../src/config/schema";

const cfg: WarehousdConfig = {
  project: "t", server: { port: 1 }, synthetic: { documents_per_collection: { people: 10, salaries: 20 } },
  collections: {
    people: { description: "dir", fields: {
      id: { type: "uuid", posture: "allow", pk: true },
      full_name: { type: "text", posture: "allow" },
    }},
    salaries: { description: "comp", fields: {
      id: { type: "uuid", posture: "allow", pk: true },
      person_id: { type: "uuid", posture: "allow", fk: "people.id" },
      base_salary: { type: "numeric", posture: "allow", min: 40000, max: 200000 },
    }},
  },
};

let p: Provisioned;
afterAll(async () => { await p?.end(); });

it("is deterministic for a fixed seed and honors FK integrity", async () => {
  p = await provision("synth");
  const db = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(db);
  await applyConfig(db, cfg);

  await generateSynthetic(db, cfg, 42);
  const first = await db.query(`select full_name from data_synth.people order by id`);

  // regenerate with same seed → identical
  await db.query(`truncate data_synth.people, data_synth.salaries`);
  await generateSynthetic(db, cfg, 42);
  const second = await db.query(`select full_name from data_synth.people order by id`);
  expect(second.rows).toEqual(first.rows);

  // FK integrity: every salary.person_id exists in people
  const orphans = await db.query(
    `select 1 from data_synth.salaries s
     left join data_synth.people p on p.id = s.person_id where p.id is null`);
  expect(orphans.rowCount).toBe(0);

  const counts = await db.query(`select count(*)::int c from data_synth.people`);
  expect(counts.rows[0].c).toBe(10);
  await db.end();
});

describe("synthetic: taxonomy terms", () => {
  it("bound field gets only valid term slugs, deterministically", async () => {
    const cfg = ConfigSchema.parse({
      project: "t", server: { port: 1 },
      synthetic: { documents_per_collection: { notes: 30 } },
      taxonomies: { category: { label: "C", terms: {
        hr: { label: "HR" }, finance: { label: "Fin" }, legal: { label: "Legal" } } } },
      collections: { notes: { description: "d", taxonomies: ["category"], fields: {
        id: { type: "uuid", posture: "allow", pk: true } } } },
    });
    const p2 = await provision("synth2");
    const db = new Pool({ connectionString: p2.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, cfg);
    await generateSynthetic(db, cfg, 7);
    const rows = (await db.query(`select category from data_synth.notes`)).rows;
    expect(rows.length).toBe(30);
    const valid = new Set(["hr", "finance", "legal"]);
    for (const r of rows) expect(valid.has(r.category)).toBe(true);
    // determinism: regenerate with the same seed → identical multiset
    const first = rows.map((r) => r.category).sort();
    await db.query(`truncate data_synth.notes`);
    await generateSynthetic(db, cfg, 7);
    const again = (await db.query(`select category from data_synth.notes`)).rows.map((r) => r.category).sort();
    expect(again).toEqual(first);
    await db.end();
  });
});

describe("synthetic: dataset-sourced taxonomy terms", () => {
  // The term set is distinct `clients.client_number`, so it does not exist until `clients`
  // has rows — the generator has to fill this column in a pass after the inserts.
  const base = (multiple: boolean) => ({
    project: "t", server: { port: 1 },
    synthetic: { documents_per_collection: { clients: 12, matters: 25 } },
    taxonomies: { client: { label: "Client", multiple,
      source: { collection: "clients", slug: "client_number", label: "name" } } },
    collections: {
      clients: { description: "d", fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        client_number: { type: "text", posture: "allow", gen: "client_number" },
        name: { type: "text", posture: "allow", gen: "company_name" },
      }},
      matters: { description: "d", taxonomies: ["client"], fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        matter_number: { type: "text", posture: "allow", gen: "matter_number" },
      }},
    },
  });

  it("fills a single-value bound column with real slugs, deterministically", async () => {
    const cfg = ConfigSchema.parse(base(false));
    const p2 = await provision("synth_dsvocab");
    const db = new Pool({ connectionString: p2.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, cfg);
    await generateSynthetic(db, cfg, 11);

    const expected = new Set(
      (await db.query(`select client_number from data_synth.clients`)).rows
        .map((r) => r.client_number.toLowerCase()));
    const rows = (await db.query(`select client from data_synth.matters order by id`)).rows;
    expect(rows.length).toBe(25);
    expect(rows.filter((r) => r.client === null).length).toBe(0);
    for (const r of rows) expect(expected.has(r.client)).toBe(true);

    // Same seed → same assignment. regenerate.test.ts depends on this holding.
    await db.query(`truncate data_synth.clients, data_synth.matters`);
    await generateSynthetic(db, cfg, 11);
    const again = (await db.query(`select client from data_synth.matters order by id`)).rows;
    expect(again).toEqual(rows);
    await db.end();
    await p2.end();
  });

  it("fills a multi-value bound column with a text[] of 1-3 distinct slugs", async () => {
    const cfg = ConfigSchema.parse(base(true));
    const p2 = await provision("synth_dsvocab_multi");
    const db = new Pool({ connectionString: p2.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, cfg);
    await generateSynthetic(db, cfg, 11);

    const expected = new Set(
      (await db.query(`select client_number from data_synth.clients`)).rows
        .map((r) => r.client_number.toLowerCase()));
    const rows = (await db.query(`select client from data_synth.matters order by id`)).rows;
    expect(rows.length).toBe(25);
    for (const r of rows) {
      expect(Array.isArray(r.client)).toBe(true);
      expect(r.client.length).toBeGreaterThanOrEqual(1);
      expect(r.client.length).toBeLessThanOrEqual(3);
      expect(new Set(r.client).size).toBe(r.client.length);
      for (const slug of r.client) expect(expected.has(slug)).toBe(true);
    }
    await db.end();
    await p2.end();
  });
});

describe("synthetic: gen: hints", () => {
  it("client_number generates dense deterministic sequence", async () => {
    const cfg = ConfigSchema.parse({
      project: "t", server: { port: 1 },
      synthetic: { documents_per_collection: { matters: 10 } },
      collections: { matters: { description: "d", fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        client_number: { type: "text", posture: "allow", gen: "client_number" },
      }}},
    });
    const p2 = await provision("synth_clientnum");
    const db = new Pool({ connectionString: p2.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, cfg);
    await generateSynthetic(db, cfg, 42);
    const rows = (await db.query(`select client_number from data_synth.matters`)).rows;
    const numbers = rows.map((r) => r.client_number).sort();
    const expected = ["C-0001", "C-0002", "C-0003", "C-0004", "C-0005", "C-0006", "C-0007", "C-0008", "C-0009", "C-0010"].sort();
    expect(numbers).toEqual(expected);
    // determinism: same seed → same multiset
    await db.query(`truncate data_synth.matters`);
    await generateSynthetic(db, cfg, 42);
    const again = (await db.query(`select client_number from data_synth.matters`)).rows.map((r) => r.client_number).sort();
    expect(again).toEqual(numbers);
    await db.end();
  });

  it("matter_number generates dense deterministic sequence", async () => {
    const cfg = ConfigSchema.parse({
      project: "t", server: { port: 1 },
      synthetic: { documents_per_collection: { matters: 5 } },
      collections: { matters: { description: "d", fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        matter_number: { type: "text", posture: "allow", gen: "matter_number" },
      }}},
    });
    const p2 = await provision("synth_matternum");
    const db = new Pool({ connectionString: p2.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, cfg);
    await generateSynthetic(db, cfg, 42);
    const rows = (await db.query(`select matter_number from data_synth.matters`)).rows;
    const numbers = rows.map((r) => r.matter_number).sort();
    const expected = ["M-2025-0001", "M-2025-0002", "M-2025-0003", "M-2025-0004", "M-2025-0005"].sort();
    expect(numbers).toEqual(expected);
    await db.end();
  });

  it("invoice_number generates dense deterministic sequence", async () => {
    const cfg = ConfigSchema.parse({
      project: "t", server: { port: 1 },
      synthetic: { documents_per_collection: { invoices: 8 } },
      collections: { invoices: { description: "d", fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        invoice_number: { type: "text", posture: "allow", gen: "invoice_number" },
      }}},
    });
    const p2 = await provision("synth_invnum");
    const db = new Pool({ connectionString: p2.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, cfg);
    await generateSynthetic(db, cfg, 42);
    const rows = (await db.query(`select invoice_number from data_synth.invoices`)).rows;
    const numbers = rows.map((r) => r.invoice_number).sort();
    const expected = ["INV-2025-0001", "INV-2025-0002", "INV-2025-0003", "INV-2025-0004", "INV-2025-0005", "INV-2025-0006", "INV-2025-0007", "INV-2025-0008"].sort();
    expect(numbers).toEqual(expected);
    await db.end();
  });

  it("bar_number generates dense deterministic sequence", async () => {
    const cfg = ConfigSchema.parse({
      project: "t", server: { port: 1 },
      synthetic: { documents_per_collection: { attorneys: 3 } },
      collections: { attorneys: { description: "d", fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        bar_number: { type: "text", posture: "allow", gen: "bar_number" },
      }}},
    });
    const p2 = await provision("synth_barnum");
    const db = new Pool({ connectionString: p2.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, cfg);
    await generateSynthetic(db, cfg, 42);
    const rows = (await db.query(`select bar_number from data_synth.attorneys`)).rows;
    const numbers = rows.map((r) => r.bar_number).sort();
    const expected = ["BAR-000001", "BAR-000002", "BAR-000003"].sort();
    expect(numbers).toEqual(expected);
    await db.end();
  });
});

describe("synthetic: self-referential and cyclic FKs", () => {
  it("self-referential FK gets backfilled with non-null values for some rows", async () => {
    const cfg = ConfigSchema.parse({
      project: "t", server: { port: 1 },
      synthetic: { documents_per_collection: { people: 15 } },
      collections: { people: { description: "d", fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        full_name: { type: "text", posture: "allow" },
        manager_id: { type: "uuid", posture: "allow", fk: "people.id", nullable: true },
      }}},
    });
    const p2 = await provision("synth_selfref");
    const db = new Pool({ connectionString: p2.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, cfg);
    await generateSynthetic(db, cfg, 42);
    const rows = (await db.query(`select manager_id from data_synth.people where manager_id is not null`)).rows;
    expect(rows.length).toBeGreaterThan(0);
    // Verify FK integrity: all manager_ids exist in people
    const orphans = await db.query(`
      select count(*)::int as n from data_synth.people p
      where p.manager_id is not null and not exists (
        select 1 from data_synth.people m where m.id = p.manager_id
      )`);
    expect(orphans.rows[0].n).toBe(0);
    await db.end();
  });

  it("cyclic FK gets backfilled with non-null values", async () => {
    const cfg = ConfigSchema.parse({
      project: "t", server: { port: 1 },
      synthetic: { documents_per_collection: { departments: 8, people: 12 } },
      collections: {
        departments: { description: "d", fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          name: { type: "text", posture: "allow" },
          head_id: { type: "uuid", posture: "allow", fk: "people.id", nullable: true },
        }},
        people: { description: "d", fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          full_name: { type: "text", posture: "allow" },
          department_id: { type: "uuid", posture: "allow", fk: "departments.id", nullable: true },
        }},
      },
    });
    const p2 = await provision("synth_cyclic");
    const db = new Pool({ connectionString: p2.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, cfg);
    await generateSynthetic(db, cfg, 42);
    // At least one of the two FK cycles should be backfilled
    const deptHeads = (await db.query(`select count(*)::int as n from data_synth.departments where head_id is not null`)).rows[0].n;
    const peopleDepts = (await db.query(`select count(*)::int as n from data_synth.people where department_id is not null`)).rows[0].n;
    expect(deptHeads + peopleDepts).toBeGreaterThan(0);
    // Verify FK integrity on both sides
    const orphanDepts = await db.query(`
      select count(*)::int as n from data_synth.departments d
      where d.head_id is not null and not exists (
        select 1 from data_synth.people p where p.id = d.head_id
      )`);
    expect(orphanDepts.rows[0].n).toBe(0);
    const orphanPeople = await db.query(`
      select count(*)::int as n from data_synth.people p
      where p.department_id is not null and not exists (
        select 1 from data_synth.departments d where d.id = p.department_id
      )`);
    expect(orphanPeople.rows[0].n).toBe(0);
    await db.end();
  });
});
