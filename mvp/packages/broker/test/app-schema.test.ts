import { describe, it, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";

let p: Provisioned;
afterAll(async () => { await p?.end(); });

describe("app schema", () => {
  it("creates collections, grants, audit_events tables", async () => {
    p = await provision("appschema");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    const r = await db.query(
      `select table_name from information_schema.tables where table_schema='app' order by table_name`);
    await db.end();
    expect(r.rows.map((x) => x.table_name)).toEqual(["audit_events", "collections", "grants"]);
  });
});
