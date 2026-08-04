import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, generateSynthetic } from "../src/index";
import { regenerateSynthetic } from "../src/synthetic/regenerate";
import { loadConfig } from "../src/config/load";

import { SEED_REV_COLUMNS, SEED_REV_VALUES } from "../src/index";

// Every dataset table carries NOT NULL revision bookkeeping, so a fixture insert has to
// be a well-formed `create` revision. These are literals; every value stays bound.
const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

let p: Provisioned, admin: Pool;
const harborDir = new URL("../../../examples/harbor", import.meta.url).pathname;
const cfg = loadConfig(harborDir);

beforeAll(async () => {
  p = await provision("regen");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  await generateSynthetic(admin, cfg, 42);
}, 60_000);
afterAll(async () => {
  await admin.end();
  await p.end();
});

const count = async (t: string) =>
  Number((await admin.query(`select count(*)::int as n from data_synth.${t}`)).rows[0].n);

describe("regenerateSynthetic", () => {
  it("is reproducible for a fixed seed", async () => {
    await regenerateSynthetic(admin, cfg, 7);
    const first = (await admin.query(`select id, full_name from data_synth.people order by id`))
      .rows;
    await regenerateSynthetic(admin, cfg, 7);
    const second = (await admin.query(`select id, full_name from data_synth.people order by id`))
      .rows;
    expect(second).toEqual(first);
  });

  it("produces different data for a different seed", async () => {
    await regenerateSynthetic(admin, cfg, 1);
    const a = (await admin.query(`select full_name from data_synth.people order by id limit 5`))
      .rows;
    await regenerateSynthetic(admin, cfg, 2);
    const b = (await admin.query(`select full_name from data_synth.people order by id limit 5`))
      .rows;
    expect(b).not.toEqual(a);
  });

  it("does not duplicate rows when run repeatedly", async () => {
    await regenerateSynthetic(admin, cfg, 42);
    const once = await count("people");
    await regenerateSynthetic(admin, cfg, 42);
    expect(await count("people")).toBe(once);
  });

  it("skips file collections — they are indexed, not generated", async () => {
    const r = await regenerateSynthetic(admin, cfg, 42);
    expect(r.collections).not.toContain("policies");
    expect(r.collections).toContain("people");
  });

  it("never touches data_live", async () => {
    await admin.query(
      `insert into data_live.departments (${R}, id, name) values (${RV}, gen_random_uuid(), 'Live Only Dept')`,
    );
    const before = Number(
      (await admin.query(`select count(*)::int as n from data_live.departments`)).rows[0].n,
    );
    await regenerateSynthetic(admin, cfg, 99);
    const after = Number(
      (await admin.query(`select count(*)::int as n from data_live.departments`)).rows[0].n,
    );
    expect(after).toBe(before);
  });

  it("preserves FK integrity across regenerations", async () => {
    await regenerateSynthetic(admin, cfg, 5);
    const orphans = await admin.query(`
      select count(*)::int as n from data_synth.salaries s
      left join data_synth.people pp on pp.id = s.person_id
      where s.person_id is not null and pp.id is null`);
    expect(orphans.rows[0].n).toBe(0);
  });
});
