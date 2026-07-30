import { describe, it, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { tableDDL, viewDDL } from "../src/apply/ddl";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";

let p: Provisioned;
afterAll(async () => {
  await p?.end();
});

// Parsed through ConfigSchema, not hand-built: a hand-built literal skips the refinements, so
// a test could assert against a configuration the loader would actually reject.
const nonWritableCfg: WarehousdConfig = ConfigSchema.parse({
  project: "t",
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

const writableCfg: WarehousdConfig = ConfigSchema.parse({
  project: "t",
  collections: {
    pages: {
      description: "d",
      writable: true,
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        title: { type: "text", posture: { read: "allow", write: "allow" } },
        body: { type: "text", posture: { read: "allow", write: "allow" } },
      },
    },
  },
});

const REV_COLS = [
  "_rev",
  "_rev_seq",
  "_rev_at",
  "_rev_by",
  "_rev_op",
  "_rev_status",
  "_rev_fields",
  "_rev_base",
  "_current",
];

describe("dataset revision DDL", () => {
  it("a writable: true dataset gets _rev*, _current, and the partial unique index", async () => {
    p = await provision("revisions-ddl");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, writableCfg);

    for (const schema of ["data_synth", "data_live"]) {
      for (const col of REV_COLS) {
        const r = await db.query(
          `select 1 from information_schema.columns
           where table_schema=$1 and table_name='pages' and column_name=$2`,
          [schema, col],
        );
        expect(r.rowCount, `${schema}.pages should have ${col}`).toBe(1);
      }
      // The declared pk is document identity now, not row identity: many revisions share it.
      const pkOnId = await db.query(
        `select 1 from information_schema.table_constraints tc
           join information_schema.key_column_usage k using (constraint_name, table_schema)
         where tc.table_schema=$1 and tc.table_name='pages'
           and tc.constraint_type='PRIMARY KEY' and k.column_name='id'`,
        [schema],
      );
      expect(pkOnId.rowCount, `${schema}.pages id must not be the primary key`).toBe(0);
    }

    // Exactly-one-current is a database guarantee, not an ordering convention.
    const idx = await db.query(
      `select indexdef from pg_indexes
       where schemaname='data_live' and tablename='pages' and indexname='pages_current_idx'`,
    );
    expect(idx.rowCount).toBe(1);
    expect(idx.rows[0].indexdef.toLowerCase()).toContain("unique");
    expect(idx.rows[0].indexdef.toLowerCase()).toContain("(org_id, id)");
    expect(idx.rows[0].indexdef.toLowerCase()).toContain("where _current");

    await db.end();
  });

  it("the partial unique index rejects a second current revision for one document", async () => {
    p = await provision("revisions-ddl");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, writableCfg);

    const insert = (current: boolean) =>
      db.query(
        `insert into data_live.pages
         (_rev_seq,_rev_by,_rev_op,_rev_status,_rev_fields,_current,org_id,id,title)
       values (1,'u','create','approved','{title}',$1,'default',
               '11111111-1111-1111-1111-111111111111','t')`,
        [current],
      );

    await insert(true);
    await expect(insert(true)).rejects.toThrow(/duplicate key|unique/i);
    // A non-current revision never contends — that is what lets proposals coexist.
    await expect(insert(false)).resolves.toBeDefined();

    await db.end();
  });

  it("a non-writable dataset gains no revision machinery at all", () => {
    const ddl = tableDDL("live", "people", nonWritableCfg);
    expect(ddl).not.toContain("_rev");
    expect(ddl).not.toContain("_current");
    // Its pk stays a real primary key: without revisions, row identity IS document identity.
    expect(ddl).toContain("primary key");

    const view = viewDDL("live", "people", nonWritableCfg);
    expect(view).not.toContain("_current");
    expect(view).not.toContain("_rev_op");
  });

  it("the view hides non-current and tombstoned revisions", async () => {
    p = await provision("revisions-ddl");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, writableCfg);

    const view = viewDDL("live", "pages", writableCfg);
    expect(view).toContain("_current");
    expect(view).toContain("_rev_op <> 'delete'");

    const rev = (seq: number, op: string, current: boolean, title: string) =>
      db.query(
        `insert into data_live.pages
         (_rev_seq,_rev_by,_rev_op,_rev_status,_rev_fields,_current,org_id,id,title)
       values ($1,'u',$2,'approved','{title}',$3,'default',
               '22222222-2222-2222-2222-222222222222',$4)`,
        [seq, op, current, title],
      );

    await db.query(`select set_config('warehousd.org_id','default',false)`);
    await rev(1, "create", false, "superseded");
    await rev(2, "update", true, "current");
    expect((await db.query(`select title from data_live.v_pages`)).rows).toEqual([
      { title: "current" },
    ]);

    // A delete is a tombstone: the document leaves the view, the history stays in the table.
    await db.query(`update data_live.pages set _current=false where _rev_seq=2`);
    await rev(3, "delete", true, "current");
    expect((await db.query(`select title from data_live.v_pages`)).rowCount).toBe(0);
    expect((await db.query(`select count(*)::int as n from data_live.pages`)).rows[0].n).toBe(3);

    await db.end();
  });

  it("applying twice is idempotent", async () => {
    p = await provision("revisions-ddl");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, writableCfg);
    await expect(applyConfig(db, writableCfg)).resolves.not.toThrow();
    await db.end();
  });

  it("turning writable: true on over an existing plain table fails the apply", async () => {
    p = await provision("revisions-ddl");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, nonWritableCfg);

    // Same collection name, now writable — the table exists without _rev*, and migrating
    // existing rows into revisions is out of scope, so this must refuse rather than
    // silently emit a table that cannot hold a revision.
    const migrated = ConfigSchema.parse({
      project: "t",
      collections: {
        people: {
          description: "dir",
          writable: true,
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            email: { type: "text", posture: { read: "allow", write: "allow" } },
          },
        },
      },
    });
    await expect(applyConfig(db, migrated)).rejects.toThrow(/writable/i);
    await db.end();
  });
});

describe("file collection storage", () => {
  const fileCfg: WarehousdConfig = ConfigSchema.parse({
    project: "t",
    collections: {
      policies: {
        type: "file",
        description: "d",
        source: "./x",
        writable: true,
        fields: {
          title: { posture: { read: "allow", write: "allow" } },
          content: { posture: { read: "allow", write: "allow" } },
          path: { posture: "deny" },
        },
      },
    },
  });

  it("a writable file collection keeps its shape — append-only needs no revisions", async () => {
    p = await provision("revisions-ddl");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, fileCfg);

    for (const t of ["policies__files", "policies__documents"]) {
      const cols = (
        await db.query(
          `select column_name from information_schema.columns
         where table_schema='data_live' and table_name=$1`,
          [t],
        )
      ).rows.map((r) => r.column_name);
      for (const c of REV_COLS) expect(cols, `${t} must not carry ${c}`).not.toContain(c);
    }

    // path stays unique, which is what makes create idempotent and a repeat a conflict.
    const uniq = await db.query(
      `select 1 from pg_indexes where schemaname='data_live'
       and tablename='policies__files' and indexdef ilike '%unique%path%'`,
    );
    expect(uniq.rowCount).toBe(1);

    await db.end();
  });
});
