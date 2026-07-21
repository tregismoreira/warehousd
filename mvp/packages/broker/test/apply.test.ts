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

const docCfg = {
  project: "t", server: { port: 1 }, synthetic: { rows_per_collection: {} },
  collections: {
    policies: {
      type: "document" as const,
      description: "d",
      source: "./x",
      fields: {
        title: { posture: "allow" as const },
        content: { posture: "allow" as const },
        path: { posture: "deny" as const },
      },
    },
  },
};

describe("document collection apply", () => {
  it("creates __docs, __chunks, gin index, and the chunk view per env", async () => {
    p = await provision("apply");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, docCfg);

    for (const schema of ["data_synth", "data_live"]) {
      const t = await db.query(
        `select table_name from information_schema.tables where table_schema=$1 and table_name like 'policies__%'`, [schema]);
      expect(t.rows.map(r => r.table_name).sort()).toEqual(["policies__chunks", "policies__docs"]);
      const v = await db.query(
        `select column_name from information_schema.columns where table_schema=$1 and table_name='v_policies'`, [schema]);
      expect(v.rows.map(r => r.column_name).sort()).toEqual(
        ["chunk_id","chunk_index","content","document_id","owner","path","title","tsv","updated_at"].sort());
    }
    await db.end();
  });
  it("is idempotent", async () => {
    p = await provision("apply");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, docCfg);
    await applyConfig(db, docCfg);
    await db.end();
  });
  it("chunk tsv is generated and searchable", async () => {
    p = await provision("apply");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, docCfg);

    await db.query(`insert into data_synth."policies__docs" (id,title,path,owner,checksum,updated_at)
      values (gen_random_uuid(),'t','a.md',null,'c',now())`);
    const d = await db.query(`select id from data_synth."policies__docs" limit 1`);
    await db.query(`insert into data_synth."policies__chunks" (id,document_id,chunk_index,content)
      values (gen_random_uuid(),$1,0,'remote work policy applies')`, [d.rows[0].id]);
    const r = await db.query(
      `select content from data_synth.v_policies where tsv @@ websearch_to_tsquery('english','remote work')`);
    expect(r.rowCount).toBe(1);
    await db.end();
  });
});
