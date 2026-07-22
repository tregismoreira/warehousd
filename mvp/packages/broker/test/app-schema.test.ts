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
    expect(r.rows.map((x) => x.table_name)).toEqual(["audit_events", "collections", "grants", "terms", "vocabularies"]);
  });
});

describe("taxonomy tables", () => {
  it("vocabularies: slug unique; terms: (vocabulary_id, slug) unique, parent_id reserved-null", async () => {
    p = await provision("appschema");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    const vid = (await db.query(
      `insert into app.vocabularies (slug, label) values ('category','Category') returning id`)).rows[0].id;
    await expect(db.query(
      `insert into app.vocabularies (slug, label) values ('category','Again')`)).rejects.toThrow();
    await db.query(`insert into app.terms (vocabulary_id, slug, label) values ($1,'hr','HR')`, [vid]);
    await expect(db.query(
      `insert into app.terms (vocabulary_id, slug, label) values ($1,'hr','HR again')`, [vid])).rejects.toThrow();
    const t = (await db.query(`select parent_id from app.terms where slug='hr'`)).rows[0];
    expect(t.parent_id).toBeNull();   // hierarchy column reserved, unused in MVP
    await db.end();
  });

  it("cascade-deletes terms with their vocabulary", async () => {
    p = await provision("appschema");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    const vid = (await db.query(
      `insert into app.vocabularies (slug, label) values ('tmp','Tmp') returning id`)).rows[0].id;
    await db.query(`insert into app.terms (vocabulary_id, slug, label) values ($1,'x','X')`, [vid]);
    await db.query(`delete from app.vocabularies where id=$1`, [vid]);
    const left = await db.query(`select 1 from app.terms where vocabulary_id=$1`, [vid]);
    expect(left.rowCount).toBe(0);
    await db.end();
  });
});
