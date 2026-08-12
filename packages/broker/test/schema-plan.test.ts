import { describe, it, expect } from "vitest";
import { classifyCast, planFromConfigs } from "../src/apply/plan";
import { declaredTables, declaredPkField } from "../src/apply/ddl";
import { renderMigrationSql, nextMigrationFilename } from "../src/apply/migration-sql";
import { ConfigSchema } from "../src/config/schema";

// A collection whose fields cover every mapped Postgres type, so a change to PG_TYPE or to the
// vocabulary rule shows up here rather than in production.
function cfgWith(fields: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return ConfigSchema.parse({
    project: "t",
    collections: { orders: { description: "d", fields, ...extra } },
  });
}

describe("classifyCast", () => {
  it("treats a widening cast as lossless and casts in place", () => {
    for (const [from, to] of [
      ["integer", "numeric"],
      ["integer", "text"],
      ["numeric", "text"],
      ["uuid", "text"],
      ["date", "timestamptz"],
    ] as const) {
      const r = classifyCast(from, to, "amount");
      expect(r.reviewRequired, `${from} → ${to} should be lossless`).toBe(false);
      expect(r.using).toBe(`"amount"::${to}`);
    }
  });

  it("treats a narrowing cast as needing review", () => {
    for (const [from, to] of [
      ["text", "numeric"],
      ["text", "integer"],
      ["numeric", "integer"],
      ["timestamptz", "date"],
      ["text", "uuid"],
      ["text", "jsonb"],
    ] as const) {
      expect(classifyCast(from, to, "amount").reviewRequired, `${from} → ${to}`).toBe(true);
    }
  });

  // multiple: false → true. Wrapping a scalar keeps every value, so it needs no review; the
  // reverse collapses a list to one element and is exactly the loss this module exists to catch.
  it("wraps a scalar into an array losslessly and refuses the reverse without review", () => {
    const up = classifyCast("text", "text[]", "region");
    expect(up.reviewRequired).toBe(false);
    expect(up.using).toBe(`case when "region" is null then null else array["region"] end`);

    const down = classifyCast("text[]", "text", "region");
    expect(down.reviewRequired).toBe(true);
    expect(down.using).toBe(`array_to_string("region", ',')`);
  });

  // An unmapped pair must land on the cautious side rather than falling through as lossless.
  it("defaults an unknown pair to needing review", () => {
    expect(classifyCast("jsonb", "integer", "x").reviewRequired).toBe(true);
  });
});

describe("declaredTables", () => {
  it("maps every field type to its Postgres type and marks the pk", () => {
    const cfg = cfgWith({
      id: { type: "uuid", posture: "allow", pk: true },
      amount: { type: "numeric", posture: "allow" },
      qty: { type: "int", posture: "allow" },
      note: { type: "text", posture: "allow" },
      at: { type: "timestamptz", posture: "allow" },
      on_: { type: "date", posture: "allow" },
      ok: { type: "boolean", posture: "allow" },
      blob: { type: "json", posture: "allow" },
    });
    const [t] = declaredTables("orders", cfg);
    expect(t!.table).toBe("orders");
    expect(t!.columns).toEqual([
      { name: "id", pgType: "uuid", pk: true },
      { name: "amount", pgType: "numeric", pk: false },
      { name: "qty", pgType: "integer", pk: false },
      { name: "note", pgType: "text", pk: false },
      { name: "at", pgType: "timestamptz", pk: false },
      { name: "on_", pgType: "date", pk: false },
      { name: "ok", pgType: "boolean", pk: false },
      { name: "blob", pgType: "jsonb", pk: false },
    ]);
    // workspace_id, the revision bookkeeping every dataset carries, plus a reserved `<field>_tsv` slot
    // per field — see the note in declaredTables on why the slot is reserved whether or not the
    // field is currently searchable.
    expect(t!.structural).toEqual([
      "workspace_id",
      "_rev",
      "_rev_seq",
      "_rev_at",
      "_rev_by",
      "_rev_op",
      "_rev_status",
      "_rev_fields",
      "_rev_base",
      "_current",
      "id_tsv",
      "amount_tsv",
      "qty_tsv",
      "note_tsv",
      "at_tsv",
      "on__tsv",
      "ok_tsv",
      "blob_tsv",
    ]);
    expect(declaredPkField("orders", cfg)).toBe("id");
  });

  // A stranded column is only findable if the planner knows which columns it is not responsible
  // for. Get this wrong and every writable collection reports nine phantom drop_columns.
  it("counts revision, search and workspace columns as structural, not declared", () => {
    const cfg = ConfigSchema.parse({
      project: "t",
      collections: {
        orders: {
          description: "d",
          writable: true,
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            note: { type: "text", posture: { read: "allow", write: "allow" }, searchable: true },
          },
        },
      },
    });
    const [t] = declaredTables("orders", cfg);
    expect(t!.columns.map((c) => c.name)).toEqual(["id", "note"]);
    expect(t!.structural).toContain("workspace_id");
    expect(t!.structural).toContain("note_tsv");
    expect(t!.structural).toContain("_rev");
    expect(t!.structural).toContain("_current");
  });

  it("gives a multiple vocabulary a text[] column and a single one text", () => {
    const cfg = ConfigSchema.parse({
      project: "t",
      taxonomies: {
        region: { label: "R", multiple: true, terms: { emea: { label: "EMEA" } } },
        tier: { label: "T", terms: { gold: { label: "Gold" } } },
      },
      collections: {
        orders: {
          description: "d",
          taxonomies: ["region", "tier"],
          fields: { id: { type: "uuid", posture: "allow", pk: true } },
        },
      },
    });
    const cols = new Map(declaredTables("orders", cfg)[0]!.columns.map((c) => [c.name, c.pgType]));
    expect(cols.get("region")).toBe("text[]");
    expect(cols.get("tier")).toBe("text");
  });

  it("splits a file collection into files and documents, with metadata declared", () => {
    const cfg = ConfigSchema.parse({
      project: "t",
      collections: {
        policies: {
          type: "file",
          description: "d",
          source: "./x",
          fields: {
            title: { posture: "allow" },
            content: { posture: "allow" },
            review_date: { type: "date", posture: "allow" },
          },
        },
      },
    });
    const tables = declaredTables("policies", cfg);
    expect(tables.map((t) => t.table)).toEqual(["policies__files", "policies__documents"]);
    expect(tables[0]!.columns).toEqual([{ name: "review_date", pgType: "date", pk: false }]);
    // title/content/path are fixed file columns the DDL owns, not stranding candidates.
    expect(tables[0]!.structural).toContain("title");
    expect(tables[1]!.columns).toEqual([]);
  });

  // A view_join column is computed in the view and stored nowhere, so it can never strand data
  // and must never be reported as a column that went missing.
  it("ignores view_join fields", () => {
    const cfg = ConfigSchema.parse({
      project: "t",
      collections: {
        people: { description: "d", fields: { id: { type: "uuid", posture: "allow", pk: true } } },
        orders: {
          description: "d",
          fields: {
            id: { type: "uuid", posture: "allow", pk: true },
            owner_id: { type: "uuid", posture: "allow", fk: "people.id" },
            owner_name: {
              type: "text",
              posture: "allow",
              view_join: { table: "people", column: "id", on: "owner_id" },
            },
          },
        },
      },
    });
    expect(declaredTables("orders", cfg)[0]!.columns.map((c) => c.name)).toEqual([
      "id",
      "owner_id",
    ]);
  });
});

describe("planFromConfigs", () => {
  const before = cfgWith({
    id: { type: "uuid", posture: "allow", pk: true },
    amount: { type: "text", posture: "allow" },
    note: { type: "text", posture: "allow" },
  });

  it("reports a type change as destructive and an added field as not", () => {
    const after = cfgWith({
      id: { type: "uuid", posture: "allow", pk: true },
      amount: { type: "numeric", posture: "allow" },
      note: { type: "text", posture: "allow" },
      shipped: { type: "boolean", posture: "allow" },
    });
    const plan = planFromConfigs(before, after);

    const typeChange = plan.find((c) => c.kind === "type_change");
    expect(typeChange).toMatchObject({
      collection: "orders",
      field: "amount",
      from: "text",
      to: "numeric",
      destructive: true,
      reviewRequired: true,
    });

    const added = plan.find((c) => c.kind === "add_column");
    expect(added).toMatchObject({ field: "shipped", destructive: false });
  });

  it("reports a removed field as a destructive drop, and points at rename", () => {
    const after = cfgWith({
      id: { type: "uuid", posture: "allow", pk: true },
      amount: { type: "text", posture: "allow" },
    });
    const plan = planFromConfigs(before, after);
    const dropped = plan.find((c) => c.kind === "drop_column");
    expect(dropped).toMatchObject({ field: "note", destructive: true });
    expect(dropped!.detail).toMatch(/renamed/i);
  });

  it("reports a moved primary key and a removed collection", () => {
    const movedPk = cfgWith({
      id: { type: "uuid", posture: "allow" },
      amount: { type: "text", posture: "allow", pk: true },
      note: { type: "text", posture: "allow" },
    });
    expect(planFromConfigs(before, movedPk).find((c) => c.kind === "pk_change")).toMatchObject({
      from: "id",
      to: "amount",
      destructive: true,
    });

    const empty = ConfigSchema.parse({ project: "t", collections: {} });
    expect(planFromConfigs(before, empty)).toMatchObject([
      { kind: "drop_collection", collection: "orders", destructive: true },
    ]);
  });

  it("reports nothing when the config is unchanged", () => {
    expect(planFromConfigs(before, before)).toEqual([]);
  });

  // A brand-new collection has no previous shape, so nothing about it can be destructive.
  it("says nothing about a collection that did not exist before", () => {
    const added = ConfigSchema.parse({
      project: "t",
      collections: {
        orders: { description: "d", fields: { id: { type: "uuid", posture: "allow", pk: true } } },
        invoices: {
          description: "d",
          fields: { id: { type: "uuid", posture: "allow", pk: true } },
        },
      },
    });
    expect(planFromConfigs(before, added).filter((c) => c.collection === "invoices")).toEqual([]);
  });
});

describe("renderMigrationSql", () => {
  const cfg = ConfigSchema.parse({
    project: "t",
    collections: {
      orders: {
        description: "d",
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          amount: { type: "numeric", posture: "allow" },
          note: { type: "text", posture: "allow", searchable: true },
        },
      },
    },
  });

  const from = (fields: Record<string, unknown>) => planFromConfigs(cfgWith(fields), cfg);

  const lossy = {
    id: { type: "uuid", posture: "allow", pk: true },
    amount: { type: "text", posture: "allow" },
    note: { type: "text", posture: "allow", searchable: true },
  };

  it("drops the view before altering, because a view blocks ALTER on its columns", () => {
    const sql = renderMigrationSql(from(lossy));
    const viewAt = sql.indexOf("drop view if exists data_live.v_orders;");
    const alterAt = sql.indexOf("alter column");
    expect(viewAt).toBeGreaterThan(-1);
    expect(viewAt).toBeLessThan(alterAt);
  });

  it("comments out a lossy cast under a REVIEW header that lists the alternatives", () => {
    const sql = renderMigrationSql(from(lossy));
    expect(sql).toContain("-- REVIEW: orders.amount — text → numeric");
    expect(sql).toContain(
      `-- alter table data_live."orders" alter column "amount" type numeric using "amount"::numeric;`,
    );
    expect(sql).toMatch(/Rename instead of retyping/);
    // The statement must not be live: an unreviewed lossy cast running by itself is the failure.
    expect(sql).not.toMatch(/^alter table data_live\."orders" alter column "amount"/m);
  });

  it("emits a lossless cast ready to run", () => {
    const sql = renderMigrationSql(
      from({
        id: { type: "uuid", posture: "allow", pk: true },
        amount: { type: "int", posture: "allow" },
        note: { type: "text", posture: "allow", searchable: true },
      }),
    );
    expect(sql).toMatch(/^alter table data_live\."orders" alter column "amount" type numeric/m);
    expect(sql).not.toContain("-- REVIEW: orders.amount");
  });

  // A generated tsv column is computed from the column being altered, so Postgres refuses the
  // ALTER while it exists. Whether one is in the way is a fact about the database, not about the
  // config being applied: `amount` is not searchable in either config here, and the drop still has
  // to be emitted — a field can also be losing `searchable: true` in the very same change.
  //
  // The drop is live, not commented, in both branches: a generated column holds nothing that is
  // not derived, and leaving it commented is how an operator who uncomments only the cast gets a
  // migration that fails on the first row.
  it("always drops the generated search column for the field it is retyping", () => {
    const sql = renderMigrationSql(from(lossy));
    expect(sql).toMatch(/^alter table data_live\."orders" drop column if exists "amount_tsv";/m);
  });

  it("offers rename before drop for a removed field", () => {
    const sql = renderMigrationSql(
      from({
        id: { type: "uuid", posture: "allow", pk: true },
        amount: { type: "numeric", posture: "allow" },
        note: { type: "text", posture: "allow", searchable: true },
        legacy_ref: { type: "text", posture: "allow" },
      }),
    );
    const renameAt = sql.indexOf("rename column");
    const dropAt = sql.indexOf(`drop column if exists "legacy_ref"`);
    expect(renameAt).toBeGreaterThan(-1);
    expect(renameAt).toBeLessThan(dropAt);
  });

  it("says so plainly when there is nothing destructive to do", () => {
    expect(renderMigrationSql([])).toContain("No destructive changes");
  });
});

describe("nextMigrationFilename", () => {
  it("numbers from the highest existing version and slugifies the name", () => {
    expect(nextMigrationFilename([], "Widen amount")).toBe("0001-widen-amount.sql");
    expect(nextMigrationFilename(["0001-a.sql", "0009-b.sql", "0002-c.sql"], "fix the pk")).toBe(
      "0010-fix-the-pk.sql",
    );
  });

  it("falls back to a usable name when the slug is empty", () => {
    expect(nextMigrationFilename([], "!!!")).toBe("0001-migration.sql");
  });
});
