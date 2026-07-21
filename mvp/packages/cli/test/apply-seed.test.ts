import { it, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "../../broker/test/helpers/db";
import { runApply, runSeed } from "../src/index";
import { join } from "node:path";

// NOTE: depends on examples/meridian, excluded from mvp/ until Task 12 recreates it — expected to fail until then.

let p: Provisioned;
afterAll(async () => { await p?.end(); });

it("runApply then runSeed provisions and populates data_synth", async () => {
  p = await provision("cli");
  const dir = join(__dirname, "../../../examples/meridian");
  await runApply(dir, p.urls.admin);
  await runSeed(dir, p.urls.admin, 42);
  const db = new Pool({ connectionString: p.urls.admin });
  const c = await db.query(`select count(*)::int c from data_synth.people`);
  await db.end();
  expect(c.rows[0].c).toBe(40);
});
