import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { planFromSchema } from "../src/apply/plan";
import { renderMigrationSql } from "../src/apply/migration-sql";
import {
  runProjectMigrations,
  readProjectMigrations,
  projectMigrationStatus,
} from "../src/db/project-migrations";
import { ConfigSchema, type WarehousdConfig } from "../src/config/schema";
import { SEED_REV_COLUMNS, SEED_REV_VALUES } from "../src/index";

// Every dataset table carries NOT NULL revision bookkeeping, so a fixture insert has to be a
// well-formed `create` revision. These are literals; every value stays bound.
const R = SEED_REV_COLUMNS;
const RV = SEED_REV_VALUES;

let p: Provisioned;
const dirs: string[] = [];
afterAll(async () => {
  await p?.end();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "warehousd-migrations-"));
  dirs.push(dir);
  if (Object.keys(files).length > 0) {
    mkdirSync(join(dir, "migrations"));
    for (const [name, sql] of Object.entries(files))
      writeFileSync(join(dir, "migrations", name), sql);
  }
  return dir;
}

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

describe("readProjectMigrations", () => {
  it("is empty when the project has no migrations directory", () => {
    expect(readProjectMigrations(project())).toEqual([]);
  });

  it("reads .sql files in filename order and ignores anything else", () => {
    const dir = project({
      "0002-b.sql": "select 2;",
      "0001-a.sql": "select 1;",
      "notes.md": "not a migration",
    });
    expect(readProjectMigrations(dir).map((m) => m.version)).toEqual(["0001-a", "0002-b"]);
  });
});

describe("runProjectMigrations", () => {
  it("applies pending migrations in order and records them", async () => {
    p = await provision("proj_migrations_apply");
    const db = testPool({ connectionString: p.urls.admin });
    await createAppSchema(db);

    const dir = project({
      "0001-a.sql": `create table data_live.mig_probe (n int);
                     insert into data_live.mig_probe values (1);`,
      "0002-b.sql": `insert into data_live.mig_probe values (2);`,
    });

    expect(await runProjectMigrations(db, dir)).toEqual(["0001-a", "0002-b"]);
    const { rows } = await db.query(`select n from data_live.mig_probe order by n`);
    expect(rows.map((r) => r.n)).toEqual([1, 2]);

    // A second boot must do nothing at all.
    expect(await runProjectMigrations(db, dir)).toEqual([]);
    expect((await db.query(`select count(*)::int as n from data_live.mig_probe`)).rows[0].n).toBe(
      2,
    );
    await db.end();
  });

  // A silent skip is how the file on disk and the schema in production stop describing each other.
  it("refuses a migration whose file changed after it was applied", async () => {
    p = await provision("proj_migrations_edited");
    const db = testPool({ connectionString: p.urls.admin });
    await createAppSchema(db);

    const dir = project({ "0001-a.sql": `create table data_live.mig_edit (n int);` });
    await runProjectMigrations(db, dir);

    writeFileSync(
      join(dir, "migrations", "0001-a.sql"),
      `create table data_live.mig_edit2 (n int);`,
    );
    await expect(runProjectMigrations(db, dir)).rejects.toThrow(
      /already applied but its file has changed/,
    );

    // And it must not have run the new text either.
    const t = await db.query(
      `select 1 from information_schema.tables where table_schema='data_live' and table_name='mig_edit2'`,
    );
    expect(t.rowCount).toBe(0);
    await db.end();
  });

  it("rolls a failing migration back and names the version that blocked the boot", async () => {
    p = await provision("proj_migrations_fail");
    const db = testPool({ connectionString: p.urls.admin });
    await createAppSchema(db);

    const dir = project({
      "0001-ok.sql": `create table data_live.mig_ok (n int);`,
      "0002-bad.sql": `create table data_live.mig_half (n int); select * from nope_no_such_table;`,
    });

    await expect(runProjectMigrations(db, dir)).rejects.toThrow(/migration 0002-bad failed/);

    // 0001 stays applied; 0002's half is rolled back so a corrected file can retry on next boot.
    const half = await db.query(
      `select 1 from information_schema.tables where table_schema='data_live' and table_name='mig_half'`,
    );
    expect(half.rowCount).toBe(0);
    const ledger = await db.query(`select version from app.collection_migrations`);
    expect(ledger.rows.map((r) => r.version)).toEqual(["0001-ok"]);
    await db.end();
  });

  it("reports applied, pending and modified in status", async () => {
    p = await provision("proj_migrations_status");
    const db = testPool({ connectionString: p.urls.admin });
    await createAppSchema(db);

    const dir = project({ "0001-a.sql": `create table data_live.mig_st (n int);` });
    await runProjectMigrations(db, dir);
    writeFileSync(join(dir, "migrations", "0002-b.sql"), `select 1;`);
    expect(await projectMigrationStatus(db, dir)).toEqual([
      { version: "0001-a", state: "applied" },
      { version: "0002-b", state: "pending" },
    ]);

    writeFileSync(join(dir, "migrations", "0001-a.sql"), `select 99;`);
    expect((await projectMigrationStatus(db, dir))[0]).toEqual({
      version: "0001-a",
      state: "modified",
    });
    await db.end();
  });
});

// The whole point of the feature, end to end: a change that would have destroyed data is refused,
// a reviewed migration carries the data across, and the same apply then goes through.
describe("the migration path unblocks a refused change", () => {
  it("carries live rows through a lossy type change the operator reviewed", async () => {
    p = await provision("proj_migrations_e2e");
    const db = testPool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, orders("text"));
    await db.query(
      `insert into data_live.orders (${R}, id, amount) values (${RV}, gen_random_uuid(), '42.5')`,
    );

    const next = orders("numeric");
    await expect(applyConfig(db, next)).rejects.toThrow(/would destroy or strand live data/);

    // What `warehousd migrate generate` writes, with the operator uncommenting the cast — the
    // review step this design exists to force.
    const generated = renderMigrationSql(await planFromSchema(db, next));
    expect(generated).toContain("-- REVIEW: orders.amount");
    const reviewed = generated
      .split("\n")
      .map((l) => (l.startsWith(`-- alter table`) ? l.slice(3) : l))
      .join("\n");

    const dir = project({ "0001-widen-amount.sql": reviewed });
    expect(await runProjectMigrations(db, dir)).toEqual(["0001-widen-amount"]);

    // Now the drift is gone, so the same apply that was refused goes through.
    await expect(applyConfig(db, next)).resolves.not.toThrow();
    const { rows } = await db.query(`select amount from data_live.orders`);
    expect(Number(rows[0].amount)).toBe(42.5);
    const t = await db.query(
      `select data_type from information_schema.columns
        where table_schema='data_live' and table_name='orders' and column_name='amount'`,
    );
    expect(t.rows[0].data_type).toBe("numeric");
    await db.end();
  });

  // The ledger records that a migration ran, not what it was supposed to achieve. A migration
  // that does not resolve the drift must therefore still block — the schema is the check.
  it("still refuses when the migration did not actually fix the drift", async () => {
    p = await provision("proj_migrations_noop");
    const db = testPool({ connectionString: p.urls.admin });
    await createAppSchema(db);
    await applyConfig(db, orders("text"));
    await db.query(
      `insert into data_live.orders (${R}, id, amount) values (${RV}, gen_random_uuid(), '1')`,
    );

    const dir = project({ "0001-does-nothing.sql": `select 1;` });
    await runProjectMigrations(db, dir);

    await expect(applyConfig(db, orders("numeric"))).rejects.toThrow(/orders\.amount/);
    await db.end();
  });

  // A generated tsv column is computed from the column being altered, and the view selects it.
  // Both have to come down in the migration and come back in applyConfig, or this fails in
  // production on the one config that is hardest to test by hand.
  it("survives a searchable field, whose view and generated column both depend on it", async () => {
    p = await provision("proj_migrations_tsv");
    const db = testPool({ connectionString: p.urls.admin });
    await createAppSchema(db);

    const before = orders("text", { note: { type: "text", posture: "allow", searchable: true } });
    const after = orders("text", { note: { type: "int", posture: "allow" } });
    await applyConfig(db, before);
    await db.query(
      `insert into data_live.orders (${R}, id, amount, note) values (${RV}, gen_random_uuid(), '1', '7')`,
    );
    await expect(applyConfig(db, after)).rejects.toThrow(/orders\.note/);

    const reviewed = renderMigrationSql(await planFromSchema(db, after))
      .split("\n")
      .map((l) => (l.startsWith(`-- alter table`) ? l.slice(3) : l))
      .join("\n");
    const dir = project({ "0001-note-to-int.sql": reviewed });
    await runProjectMigrations(db, dir);

    await expect(applyConfig(db, after)).resolves.not.toThrow();
    const { rows } = await db.query(
      `select data_type from information_schema.columns
        where table_schema='data_live' and table_name='orders' and column_name='note'`,
    );
    expect(rows[0].data_type).toBe("integer");
    // The view came back, and the generated column went with the field that no longer declares it.
    const v = await db.query(
      `select 1 from information_schema.views where table_schema='data_live' and table_name='v_orders'`,
    );
    expect(v.rowCount).toBe(1);
    const tsv = await db.query(
      `select 1 from information_schema.columns
        where table_schema='data_live' and table_name='orders' and column_name='note_tsv'`,
    );
    expect(tsv.rowCount).toBe(0);
    await db.end();
  });
});
