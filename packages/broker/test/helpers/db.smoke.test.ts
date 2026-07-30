import { describe, it, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./db";

let p: Provisioned;
afterAll(async () => {
  await p?.end();
});

describe("provision", () => {
  it("creates a database with app + data schemas", async () => {
    p = await provision("smoke");
    const db = new Pool({ connectionString: p.urls.admin });
    const r = await db.query(
      `select schema_name from information_schema.schemata where schema_name in ('app','data_synth','data_live')`,
    );
    await db.end();
    expect(r.rows.map((x) => x.schema_name).sort()).toEqual(["app", "data_live", "data_synth"]);
  });
});
