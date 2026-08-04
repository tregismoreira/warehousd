import { describe, it, expect, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { planFromSchema } from "../src/apply/plan";
import { declaredTables } from "../src/apply/ddl";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";
import { SEED_REV_COLUMNS, SEED_REV_VALUES } from "../src/index";

// Every dataset table carries NOT NULL revision bookkeeping, so a fixture insert has to be a
// well-formed `create` revision. These are literals; every value stays bound.
const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

let p: Provisioned;
afterAll(async () => {
  await p?.end();
});

const orders = (amountType: string, extra: Record<string, unknown> = {}): WarehousdConfig =>
  ConfigSchema.parse({
    project: "t",
    collections: {
      orders: {
        description: "d",
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          amount: { type: amountType, posture: "allow" },
          ...extra,
        },
      },
    },
  });

async function columnType(db: Pool, schema: string, table: string, column: string) {
  const { rows } = await db.query<{ data_type: string }>(
    `select data_type from information_schema.columns
      where table_schema=$1 and table_name=$2 and column_name=$3`,
    [schema, table, column],
  );
  return rows[0]?.data_type ?? null;
}

// The planner is only as good as its idea of what the DDL creates. If these two ever disagree,
// every other test in this file is asserting against a fiction — so pin them together directly.
describe("declaredTables matches what applyConfig actually creates", () => {
  const rich = ConfigSchema.parse({
    project: "t",
    taxonomies: {
      region: { label: "R", multiple: true, terms: { emea: { label: "EMEA" } } },
      tier: { label: "T", terms: { gold: { label: "Gold" } } },
    },
    collections: {
      orders: {
        description: "d",
        writable: true,
        taxonomies: ["region", "tier"],
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          amount: { type: "numeric", posture: { read: "allow", write: "allow" } },
          note: { type: "text", posture: "allow", searchable: true },
          qty: { type: "int", posture: "allow" },
          ok: { type: "boolean", posture: "allow" },
          at: { type: "timestamptz", posture: "allow" },
        },
      },
      policies: {
        type: "file",
        description: "d",
        source: "./x",
        taxonomies: ["tier"],
        fields: {
          title: { posture: "allow" },
          content: { posture: "allow" },
          review_date: { type: "date", posture: "allow" },
        },
      },
    },
  });

  it("accounts for every column, in both envs, with matching types", async () => {
    p = await provision("apply_drift_decl");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, rich);

    for (const collection of ["orders", "policies"]) {
      for (const schema of ["data_synth", "data_live"]) {
        for (const decl of declaredTables(collection, rich)) {
          const { rows } = await db.query<{ column_name: string }>(
            `select column_name from information_schema.columns
              where table_schema=$1 and table_name=$2`,
            [schema, decl.table],
          );
          const actual = new Set(rows.map((r) => r.column_name));
          expect(actual.size, `${schema}.${decl.table} should exist`).toBeGreaterThan(0);

          const known = new Set([...decl.columns.map((c) => c.name), ...decl.structural]);
          for (const col of actual)
            expect(known, `${schema}.${decl.table}.${col} is unaccounted for`).toContain(col);
          for (const col of decl.columns)
            expect(
              actual,
              `${schema}.${decl.table}.${col.name} should have been created`,
            ).toContain(col.name);
        }
      }
    }

    // And a fresh apply against its own output must see no work left to do — otherwise the guard
    // would fire on a database nobody has changed.
    expect(await planFromSchema(db, rich)).toEqual([]);
    await db.end();
  });
});

describe("a destructive change to populated live data", () => {
  it("refuses, naming the collection, the field and both types", async () => {
    p = await provision("apply_drift_block");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, orders("text"));

    await db.query(
      `insert into data_live.orders (${R}, id, amount) values (${RV}, gen_random_uuid(), 'not a number')`,
    );

    await expect(applyConfig(db, orders("numeric"))).rejects.toThrow(
      /orders\.amount is text in the database and numeric in warehousd\.yml/,
    );
    // The refusal has to leave the column alone: a half-applied change is worse than none.
    expect(await columnType(db, "data_live", "orders", "amount")).toBe("text");
    expect((await db.query(`select count(*)::int as n from data_live.orders`)).rows[0].n).toBe(1);
    await db.end();
  });

  it("points at the command that unblocks it", async () => {
    p = await provision("apply_drift_hint");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, orders("text"));
    await db.query(`insert into data_live.orders (${R}, id, amount) values (${RV}, gen_random_uuid(), '1')`);

    await expect(applyConfig(db, orders("numeric"))).rejects.toThrow(/warehousd migrate generate/);
    await db.end();
  });

  it("refuses a removed field rather than stranding its column", async () => {
    p = await provision("apply_drift_drop");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, orders("text", { note: { type: "text", posture: "allow" } }));
    await db.query(
      `insert into data_live.orders (${R}, id, amount, note) values (${RV}, gen_random_uuid(), '1', 'keep me')`,
    );

    await expect(applyConfig(db, orders("text"))).rejects.toThrow(/orders\.note/);
    // Today this change is silent and the column is simply left behind. It must still be there —
    // the refusal is what gives the operator the chance to rename instead.
    expect(await columnType(db, "data_live", "orders", "note")).toBe("text");
    await db.end();
  });

  it("lists every blocked change at once, not one per apply", async () => {
    p = await provision("apply_drift_many");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, orders("text", { note: { type: "text", posture: "allow" } }));
    await db.query(`insert into data_live.orders (${R}, id, amount) values (${RV}, gen_random_uuid(), '1')`);

    const err = await applyConfig(db, orders("numeric")).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/orders\.amount/);
    expect((err as Error).message).toMatch(/orders\.note/);
    expect((err as Error).message).toMatch(/2 change\(s\)/);
    await db.end();
  });
});

describe("a destructive change with nothing to lose", () => {
  it("rebuilds an empty live table and applies the new type", async () => {
    p = await provision("apply_drift_empty");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, orders("text"));
    expect(await columnType(db, "data_live", "orders", "amount")).toBe("text");

    await applyConfig(db, orders("numeric"));
    expect(await columnType(db, "data_live", "orders", "amount")).toBe("numeric");
    // The view has to come back, or every read against the collection breaks.
    const v = await db.query(
      `select 1 from information_schema.views where table_schema='data_live' and table_name='v_orders'`,
    );
    expect(v.rowCount).toBe(1);
    await db.end();
  });

  // Synthetic data is a function of (config, seed) and is regenerated on every boot, so paying
  // migration ceremony for it would put friction on the one loop that has to stay fast.
  it("rebuilds a populated synth table without complaint", async () => {
    p = await provision("apply_drift_synth");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, orders("text"));
    await db.query(`insert into data_synth.orders (${R}, id, amount) values (${RV}, gen_random_uuid(), 'x')`);

    await applyConfig(db, orders("numeric"));
    expect(await columnType(db, "data_synth", "orders", "amount")).toBe("numeric");
    expect((await db.query(`select count(*)::int as n from data_synth.orders`)).rows[0].n).toBe(0);
    await db.end();
  });

  it("applies a moved primary key on an empty table", async () => {
    p = await provision("apply_drift_pk");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, orders("text"));

    const moved = ConfigSchema.parse({
      project: "t",
      collections: {
        orders: {
          description: "d",
          fields: {
            id: { type: "uuid", posture: "allow" },
            amount: { type: "text", posture: "allow", pk: true },
          },
        },
      },
    });
    await applyConfig(db, moved);

    // The table's own PRIMARY KEY is `_rev` on every dataset — the declared pk is DOCUMENT
    // identity, carried by the partial unique index instead (see declaredPkField). So a moved pk
    // shows up there, not on the constraint.
    const pkCols = await db.query<{ column_name: string }>(
      `select kcu.column_name from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
        where tc.constraint_type='PRIMARY KEY' and tc.table_schema='data_live'
          and tc.table_name='orders'`,
    );
    expect(pkCols.rows.map((r) => r.column_name)).toEqual(["_rev"]);

    const { rows } = await db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname='data_live' and indexname='orders_current_idx'`,
    );
    expect(rows[0]?.indexdef).toContain("amount");
    expect(rows[0]?.indexdef).not.toContain("(org_id, id)");
    await db.end();
  });

  it("drops a removed collection's empty table and clears it from the registry", async () => {
    p = await provision("apply_drift_gone");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, orders("text"));

    const empty = ConfigSchema.parse({ project: "t", collections: {} });
    await applyConfig(db, empty);

    for (const schema of ["data_synth", "data_live"]) {
      const t = await db.query(
        `select 1 from information_schema.tables where table_schema=$1 and table_name='orders'`,
        [schema],
      );
      expect(t.rowCount, `${schema}.orders should be gone`).toBe(0);
    }
    const reg = await db.query(`select 1 from app.collections where name='orders'`);
    expect(reg.rowCount).toBe(0);
    await db.end();
  });

  it("refuses to drop a removed collection that still holds live rows", async () => {
    p = await provision("apply_drift_gone_full");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, orders("text"));
    await db.query(`insert into data_live.orders (${R}, id, amount) values (${RV}, gen_random_uuid(), '1')`);

    const empty = ConfigSchema.parse({ project: "t", collections: {} });
    await expect(applyConfig(db, empty)).rejects.toThrow(/orders/);
    const t = await db.query(
      `select 1 from information_schema.tables where table_schema='data_live' and table_name='orders'`,
    );
    expect(t.rowCount).toBe(1);
    await db.end();
  });
});

describe("changes that are not destructive", () => {
  it("still adds a new field to a populated live table", async () => {
    p = await provision("apply_drift_add");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, orders("text"));
    await db.query(`insert into data_live.orders (${R}, id, amount) values (${RV}, gen_random_uuid(), '1')`);

    await applyConfig(db, orders("text", { note: { type: "text", posture: "allow" } }));
    expect(await columnType(db, "data_live", "orders", "note")).toBe("text");
    expect((await db.query(`select count(*)::int as n from data_live.orders`)).rows[0].n).toBe(1);
    await db.end();
  });

  it("is still idempotent on a populated database", async () => {
    p = await provision("apply_drift_idem");
    const db = new Pool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, orders("text"));
    await db.query(`insert into data_live.orders (${R}, id, amount) values (${RV}, gen_random_uuid(), '1')`);
    await expect(applyConfig(db, orders("text"))).resolves.not.toThrow();
    expect((await db.query(`select count(*)::int as n from data_live.orders`)).rows[0].n).toBe(1);
    await db.end();
  });
});
