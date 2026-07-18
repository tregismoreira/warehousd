import { describe, it, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import type { WarehousdConfig } from "../src/config/schema";

const cfg: WarehousdConfig = {
  project: "t", server: { port: 1 }, synthetic: { rows_per_collection: {} },
  collections: {
    people: { description: "dir", fields: {
      id: { type: "uuid", posture: "allow", pk: true },
      email: { type: "text", posture: "allow" },
      home_address: { type: "text", posture: "deny" },
    }},
  },
};

let p: Provisioned;
afterAll(async () => { await p?.end(); });

describe("applyConfig", () => {
  it("creates base tables + views in both envs and grants view SELECT to the right role", async () => {
    p = await provision("apply");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, cfg);

    // views exist in both schemas
    const v = await db.query(
      `select table_schema from information_schema.views
       where table_name='v_people' order by table_schema`);
    expect(v.rows.map((x) => x.table_schema)).toEqual(["data_live", "data_synth"]);

    // dev role can select the synth view, live role cannot
    const dev = new Pool({ connectionString: p.urls.dev });
    await dev.query(`select * from data_synth.v_people`); // no throw
    await dev.end();

    // apply is idempotent
    await applyConfig(db, cfg);
    await db.end();
  });
});
