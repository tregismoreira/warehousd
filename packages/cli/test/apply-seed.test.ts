import { it, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "../../broker/test/helpers/db";
import { runApply, runSeed } from "../src/index";
import { join } from "node:path";

let p: Provisioned;
afterAll(async () => {
  await p?.end();
});

it("runApply then runSeed provisions and populates data_synth", async () => {
  p = await provision("cli");
  const dir = join(__dirname, "../../../examples/harbor");
  await runApply(dir, p.urls.admin);
  const r = await runSeed(dir, p.urls.admin, 42, { reindex: false });
  const db = new Pool({ connectionString: p.urls.admin });
  const c = await db.query(`select count(*)::int c from data_synth.people`);
  await db.end();
  expect(c.rows[0].c).toBe(40);
  expect(r.reindexed).toEqual([]);
});

// The re-index is the default, not a flag: seeding truncates the dataset collections and rebuilds
// the term set the file rows point at, so a seed that skipped it would leave the file collections
// referring to a vocabulary that no longer exists in the same shape.
it("runSeed re-indexes every file collection by default", async () => {
  const dir = join(__dirname, "../../../examples/harbor");
  const r = await runSeed(dir, p.urls.admin, 42);
  expect(r.reindexed).toContain("policies");
  const db = new Pool({ connectionString: p.urls.admin });
  const c = await db.query(`select count(*)::int c from data_synth."policies__files"`);
  await db.end();
  expect(c.rows[0].c).toBeGreaterThan(0);
});
