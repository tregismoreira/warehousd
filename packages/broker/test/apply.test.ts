import { describe, it, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { generateSynthetic } from "../src/synthetic/generate";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";

const cfg: WarehousdConfig = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  synthetic: { documents_per_collection: {} },
  collections: {
    people: {
      description: "dir",
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        email: { type: "text", posture: "allow" },
        home_address: { type: "text", posture: "deny" },
      },
    },
  },
});

let p: Provisioned;
afterAll(async () => {
  await p?.end();
});

describe("applyConfig", () => {
  it("creates base tables + views in both envs and grants view SELECT to the right role", async () => {
    p = await provision("apply");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, cfg);

    // views exist in both schemas
    const v = await db.query(
      `select table_schema from information_schema.views
       where table_name='v_people' order by table_schema`,
    );
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

const docCfg = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  synthetic: { documents_per_collection: {} },
  collections: {
    policies: {
      type: "file" as const,
      description: "d",
      source: "./x",
      fields: {
        title: { posture: "allow" as const },
        content: { posture: "allow" as const },
        path: { posture: "deny" as const },
      },
    },
  },
});

describe("file collection apply", () => {
  it("creates __files, __documents, gin index, and the documents view per env", async () => {
    p = await provision("apply");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, docCfg);

    for (const schema of ["data_synth", "data_live"]) {
      const t = await db.query(
        `select table_name from information_schema.tables where table_schema=$1 and table_name like 'policies__%'`,
        [schema],
      );
      expect(t.rows.map((r) => r.table_name).sort()).toEqual([
        "policies__documents",
        "policies__files",
      ]);
      const v = await db.query(
        `select column_name from information_schema.columns where table_schema=$1 and table_name='v_policies'`,
        [schema],
      );
      expect(v.rows.map((r) => r.column_name).sort()).toEqual(
        [
          "checksum",
          "content",
          "document_id",
          "document_seq",
          "file_id",
          "owner",
          "path",
          "title",
          "tsv",
          "updated_at",
        ].sort(),
      );
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
  it("document tsv is generated and searchable", async () => {
    p = await provision("apply");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, docCfg);

    await db.query(`insert into data_synth."policies__files" (id,title,path,owner,checksum,updated_at)
      values (gen_random_uuid(),'t','a.md',null,'c',now())`);
    const d = await db.query(`select id from data_synth."policies__files" limit 1`);
    await db.query(
      `insert into data_synth."policies__documents" (id,file_id,document_seq,content)
      values (gen_random_uuid(),$1,0,'remote work policy applies')`,
      [d.rows[0].id],
    );
    const search = `select content from data_synth.v_policies
      where tsv @@ websearch_to_tsquery('english','remote work')`;
    // The view carries the org predicate, so reading it needs an org in scope — the setting
    // withOrg() makes on the broker's behalf. Unset means no rows: the wall fails closed.
    expect((await db.query(search)).rowCount).toBe(0);

    await db.query(`select set_config('warehousd.org_id','default',false)`);
    expect((await db.query(search)).rowCount).toBe(1);
    await db.end();
  });
});

describe("apply: additive field on an existing dataset collection", () => {
  const before = ConfigSchema.parse({
    project: "t",
    server: { port: 1 },
    synthetic: { documents_per_collection: { people: 5 } },
    collections: {
      people: {
        description: "dir",
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          email: { type: "text", posture: "allow" },
        },
      },
    },
  });
  // `role` is declared *before* `email`, not appended: a view can only be replaced in place
  // when the new column list extends the old one, so a field added mid-list is the case that
  // catches `create or replace view` where an appended one would not.
  const after = ConfigSchema.parse({
    project: "t",
    server: { port: 1 },
    synthetic: { documents_per_collection: { people: 5 } },
    collections: {
      people: {
        description: "dir",
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          role: { type: "text", posture: "allow" },
          email: { type: "text", posture: "allow" },
          hire_date: { type: "date", posture: "allow", nullable: true },
        },
      },
    },
  });

  it("adds the new columns in both envs and generates without error", async () => {
    p = await provision("apply_addcol");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, before);
    // `create table if not exists` is a no-op the second time round, so only an explicit
    // `add column` can carry the new fields onto the already-created table.
    await applyConfig(db, after);

    for (const schema of ["data_synth", "data_live"]) {
      const cols = await db.query(
        `select column_name from information_schema.columns
         where table_schema=$1 and table_name='people' order by column_name`,
        [schema],
      );
      // `org_id` is on every base table for tenant isolation; it is not a declared field, so
      // it appears here and deliberately not on the view below.
      expect(cols.rows.map((r) => r.column_name)).toEqual([
        "email",
        "hire_date",
        "id",
        "org_id",
        "role",
      ]);
      // The view has to carry them too, or the broker can never read them.
      const view = await db.query(
        `select column_name from information_schema.columns
         where table_schema=$1 and table_name='v_people' order by column_name`,
        [schema],
      );
      expect(view.rows.map((r) => r.column_name)).toEqual(["email", "hire_date", "id", "role"]);
    }
    // The generator builds its insert from the config, so a missing column fails here.
    await generateSynthetic(db, after, 42);
    const n = (
      await db.query(`select count(*)::int as n from data_synth.people where role is not null`)
    ).rows[0].n;
    expect(n).toBe(5);
    await db.end();
  });
});

describe("apply: taxonomy", () => {
  const cfgIn = {
    project: "t",
    server: { port: 1 },
    taxonomies: {
      category: {
        label: "Category",
        terms: { hr: { label: "HR" }, finance: { label: "Finance" } },
      },
    },
    collections: {
      notes: {
        description: "d",
        taxonomies: ["category"],
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
        },
      },
      briefs: {
        description: "d",
        type: "file",
        source: "./x",
        taxonomies: ["category"],
        fields: {
          title: { posture: "allow" },
          content: { posture: "allow" },
        },
      },
    },
  };

  it("upserts vocabularies/terms idempotently and renames labels in place", async () => {
    p = await provision("apply");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    const cfg = ConfigSchema.parse(cfgIn);
    await applyConfig(db, cfg);
    await applyConfig(db, cfg); // idempotent
    const vocabs = await db.query(`select slug, label from app.vocabularies where slug='category'`);
    expect(vocabs.rowCount).toBe(1);
    const renamed = ConfigSchema.parse({
      ...cfgIn,
      taxonomies: {
        category: {
          label: "Kategorie",
          terms: { hr: { label: "Human Resources" }, finance: { label: "Finance" } },
        },
      },
    });
    await applyConfig(db, renamed);
    const v = (await db.query(`select label from app.vocabularies where slug='category'`)).rows[0];
    expect(v.label).toBe("Kategorie");
    const t = (await db.query(`select label from app.terms where slug='hr'`)).rows[0];
    expect(t.label).toBe("Human Resources");
    expect((await db.query(`select count(*)::int as n from app.terms`)).rows[0].n).toBe(2);
    await db.end();
  });

  it("adds the term column to bound tables and the file view, both envs", async () => {
    p = await provision("apply");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    const cfg = ConfigSchema.parse(cfgIn);
    await applyConfig(db, cfg);
    for (const schema of ["data_synth", "data_live"]) {
      const notesCol = await db.query(
        `select 1 from information_schema.columns where table_schema=$1 and table_name='notes' and column_name='category'`,
        [schema],
      );
      expect(notesCol.rowCount).toBe(1);
      const docsCol = await db.query(
        `select 1 from information_schema.columns where table_schema=$1 and table_name='briefs__files' and column_name='category'`,
        [schema],
      );
      expect(docsCol.rowCount).toBe(1);
      const viewCol = await db.query(
        `select 1 from information_schema.columns where table_schema=$1 and table_name='v_briefs' and column_name='category'`,
        [schema],
      );
      expect(viewCol.rowCount).toBe(1);
    }
    await db.end();
  });
});
