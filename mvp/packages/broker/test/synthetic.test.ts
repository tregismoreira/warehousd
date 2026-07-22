import { describe, it, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { generateSynthetic } from "../src/synthetic/generate";
import { ConfigSchema } from "../src/config/schema";
import type { WarehousdConfig } from "../src/config/schema";

const cfg: WarehousdConfig = {
  project: "t", server: { port: 1 }, synthetic: { rows_per_collection: { people: 10, salaries: 20 } },
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
      synthetic: { rows_per_collection: { notes: 30 } },
      taxonomies: { category: { label: "C", terms: {
        hr: { label: "HR" }, finance: { label: "Fin" }, legal: { label: "Legal" } } } },
      collections: { notes: { description: "d", taxonomy: "category", fields: {
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
