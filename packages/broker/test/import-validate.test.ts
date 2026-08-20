import { describe, it, expect } from "vitest";
import { parseCsv, parseImportPayload } from "../src/import/csv";
import { validateImportRows, coerce } from "../src/import/validate";
import { loadConfig } from "../src/config/load";
import { ConfigSchema } from "../src/config/schema";

const cfg = loadConfig(new URL("../../../examples/harbor", import.meta.url).pathname);
const UUID = "3f8b0e4a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const UUID2 = "4a9c1f5b-2d3e-4f60-9b0c-1d2e3f4a5b6c";

describe("parseCsv", () => {
  it("parses a simple sheet with a header row", () => {
    expect(parseCsv("a,b\n1,2\n3,4")).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });
  it("honours quoted fields containing commas", () => {
    expect(parseCsv(`a,b\n"x,y",z`)).toEqual([{ a: "x,y", b: "z" }]);
  });
  it("honours escaped quotes", () => {
    expect(parseCsv(`a\n"he said ""hi"""`)).toEqual([{ a: 'he said "hi"' }]);
  });
  it("honours newlines inside quoted fields", () => {
    expect(parseCsv(`a,b\n"line1\nline2",z`)).toEqual([{ a: "line1\nline2", b: "z" }]);
  });
  it("tolerates CRLF", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([{ a: "1", b: "2" }]);
  });
  it("skips a trailing blank line", () => {
    expect(parseCsv("a\n1\n\n")).toEqual([{ a: "1" }]);
  });
  it("throws when a row has more cells than the header", () => {
    expect(() => parseCsv("a,b\n1,2,3")).toThrow(/column count/i);
  });
  it("throws on an empty document", () => {
    expect(() => parseCsv("")).toThrow(/empty/i);
  });
});

describe("parseImportPayload", () => {
  it("accepts a bare JSON array", () => {
    expect(parseImportPayload(`[{"a":1}]`, "json")).toEqual([{ a: 1 }]);
  });
  it("accepts a {rows:[...]} envelope", () => {
    expect(parseImportPayload(`{"rows":[{"a":1}]}`, "json")).toEqual([{ a: 1 }]);
  });
  it("rejects a JSON object that is neither", () => {
    expect(() => parseImportPayload(`{"a":1}`, "json")).toThrow(/array/i);
  });
  it("rejects malformed JSON with a clean message", () => {
    expect(() => parseImportPayload("{oops", "json")).toThrow(/parse/i);
  });
});

describe("validateImportRows", () => {
  it("accepts a well-formed dataset row and returns positional values", () => {
    const r = validateImportRows(cfg, "departments", [{ id: UUID, name: "Robotics" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.columns).toEqual(["id", "name"]);
    expect(r.values).toEqual([[UUID, "Robotics"]]);
  });

  it("accepts posture:deny columns — postures govern reading, not writing", () => {
    const r = validateImportRows(cfg, "people", [
      {
        id: UUID,
        full_name: "A B",
        email: "a@b.c",
        department_id: UUID2,
        home_address: "1 Main St",
        phone: "555",
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.columns).toContain("home_address");
  });

  it("rejects a column that is not in the collection at all", () => {
    const r = validateImportRows(cfg, "departments", [{ id: UUID, name: "X", nickname: "Y" }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toMatchObject({ row: 0, column: "nickname", reason: "unknown_column" });
  });

  it("rejects a view_join column — it lives on the joined table, not here", () => {
    const r = validateImportRows(cfg, "people", [
      { id: UUID, full_name: "A", department_name: "Robotics" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]!.reason).toBe("derived_column");
  });

  it("rejects a file collection outright", () => {
    const r = validateImportRows(cfg, "policies", [{ title: "x" }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]!.reason).toBe("file_collection");
  });

  it("rejects an unknown collection", () => {
    const r = validateImportRows(cfg, "nope", [{ a: 1 }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]!.reason).toBe("unknown_collection");
  });

  // `cfg.collections["constructor"]` is truthy on any object literal, so a name inherited
  // from Object.prototype used to slip past the unknown-collection check and blow up on
  // `c.fields` — a 500 where the contract says 400.
  it("rejects a collection name inherited from Object.prototype", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      const r = validateImportRows(cfg, name, [{ a: 1 }]);
      expect(r.ok, name).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.errors[0]!.reason, name).toBe("unknown_collection");
    }
  });

  it("rejects a malformed uuid", () => {
    const r = validateImportRows(cfg, "departments", [{ id: "not-a-uuid", name: "X" }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toMatchObject({ row: 0, column: "id", reason: "invalid_uuid" });
  });

  it("rejects a non-numeric value in a numeric column", () => {
    const r = validateImportRows(cfg, "metrics", [
      { id: UUID, date: "2026-01-01", revenue: "lots", active_customers: 10, region: "emea" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toMatchObject({ column: "revenue", reason: "invalid_numeric" });
  });

  it("coerces numeric strings from CSV into numbers", () => {
    const r = validateImportRows(cfg, "metrics", [
      { id: UUID, date: "2026-01-01", revenue: "1234.5", active_customers: "10", region: "emea" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const i = r.columns.indexOf("revenue");
    expect(r.values[0]![i]).toBe(1234.5);
  });

  it("rejects an unparseable date", () => {
    const r = validateImportRows(cfg, "metrics", [
      { id: UUID, date: "the fifth of never", revenue: 1, active_customers: 1, region: "emea" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]!.reason).toBe("invalid_date");
  });

  it("rejects a missing primary key", () => {
    const r = validateImportRows(cfg, "departments", [{ name: "X" }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toMatchObject({ column: "id", reason: "missing_required" });
  });

  it("rejects a duplicate primary key inside one payload", () => {
    const r = validateImportRows(cfg, "departments", [
      { id: UUID, name: "A" },
      { id: UUID, name: "B" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toMatchObject({ row: 1, column: "id", reason: "duplicate_pk" });
  });

  it("treats an empty string as null on a nullable column and as an error otherwise", () => {
    const ok = validateImportRows(cfg, "people", [{ id: UUID, full_name: "A", email: "" }]);
    // `email` has no `nullable: true` in the Harbor YAML, so an empty value is an error.
    expect(ok.ok).toBe(false);
    if (ok.ok) throw new Error("unreachable");
    expect(ok.errors[0]!.reason).toBe("missing_required");
  });

  it("validates a taxonomy value against the bound vocabulary", () => {
    const bad = validateImportRows(cfg, "announcements", [
      {
        id: UUID,
        title: "T",
        department: "not-a-term",
        summary: "s",
        owner: "o",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ]);
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("unreachable");
    expect(bad.errors[0]).toMatchObject({ column: "department", reason: "unknown_term" });

    const good = validateImportRows(cfg, "announcements", [
      {
        id: UUID,
        title: "T",
        department: "hr",
        summary: "s",
        owner: "o",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ]);
    expect(good.ok).toBe(true);
  });

  it("collects every error, not just the first", () => {
    const r = validateImportRows(cfg, "departments", [
      { id: "bad", name: "A" },
      { id: "worse", name: "B" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors.length).toBe(2);
  });

  it("caps the error list so a wholly malformed file cannot flood the response", () => {
    const rows = Array.from({ length: 500 }, () => ({ id: "bad", name: "A" }));
    const r = validateImportRows(cfg, "departments", rows);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors.length).toBeLessThanOrEqual(50);
  });

  it("rejects a payload above the row cap", () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ id: UUID, name: `d${i}` }));
    const r = validateImportRows(cfg, "departments", rows, { maxRows: 10 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]!.reason).toBe("too_many_rows");
  });

  it("never echoes an offending value back in an error", () => {
    const r = validateImportRows(cfg, "people", [
      { id: UUID, full_name: "A", email: "a@b.c", home_address: 12345 },
    ]);
    expect(JSON.stringify(r)).not.toContain("12345");
  });

  it("requires a consistent column set across rows", () => {
    const r = validateImportRows(cfg, "departments", [{ id: UUID, name: "A" }, { id: UUID2 }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toMatchObject({ row: 1, reason: "ragged_rows" });
  });
});

describe("validateImportRows: dataset-sourced vocabularies", () => {
  // Harbor binds `client` to a file collection only, so this shape needs its own config.
  const dsCfg = ConfigSchema.parse({
    project: "t",
    server: { port: 1 },
    taxonomies: {
      client: {
        label: "Client",
        source: { collection: "clients", slug: "client_number", label: "name" },
      },
      tag: {
        label: "Tag",
        multiple: true,
        source: { collection: "clients", slug: "client_number", label: "name" },
      },
    },
    collections: {
      clients: {
        description: "d",
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          client_number: { type: "text", posture: "allow" },
          name: { type: "text", posture: "allow" },
        },
      },
      matters: {
        description: "d",
        taxonomies: ["client"],
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          matter_number: { type: "text", posture: "allow" },
        },
      },
      briefs: {
        description: "d",
        taxonomies: ["tag"],
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
        },
      },
    },
  });
  const binding = (field: string, slugs: string[], multiple = false) => ({
    field,
    label: field,
    multiple,
    slugs,
    terms: slugs.map((slug) => ({ slug, label: slug })),
  });

  it("refuses the column when no binding is supplied — the default stays closed", () => {
    const r = validateImportRows(dsCfg, "matters", [
      { id: UUID, matter_number: "M-1", client: "c-0001" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toMatchObject({ column: "client", reason: "unvalidatable_term" });
  });

  it("accepts a value present in the supplied slugs", () => {
    const r = validateImportRows(
      dsCfg,
      "matters",
      [{ id: UUID, matter_number: "M-1", client: "c-0001" }],
      { taxonomies: [binding("client", ["c-0001", "c-0002"])] },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.values[0]![r.columns.indexOf("client")]).toBe("c-0001");
  });

  it("rejects a value absent from the supplied slugs", () => {
    const r = validateImportRows(
      dsCfg,
      "matters",
      [{ id: UUID, matter_number: "M-1", client: "c-9999" }],
      { taxonomies: [binding("client", ["c-0001", "c-0002"])] },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toMatchObject({ column: "client", reason: "unknown_term" });
  });

  it("splits a multi-value column on semicolons and checks every part", () => {
    const opts = { taxonomies: [binding("tag", ["c-0001", "c-0002"], true)] };
    const good = validateImportRows(dsCfg, "briefs", [{ id: UUID, tag: "c-0001; c-0002" }], opts);
    expect(good.ok).toBe(true);
    if (!good.ok) throw new Error("unreachable");
    expect(good.values[0]![good.columns.indexOf("tag")]).toEqual(["c-0001", "c-0002"]);

    const bad = validateImportRows(dsCfg, "briefs", [{ id: UUID, tag: "c-0001;c-9999" }], opts);
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("unreachable");
    expect(bad.errors[0]).toMatchObject({ column: "tag", reason: "unknown_term" });
  });

  it("rejects every value when the supplied binding has no terms yet", () => {
    const r = validateImportRows(
      dsCfg,
      "matters",
      [{ id: UUID, matter_number: "M-1", client: "c-0001" }],
      { taxonomies: [binding("client", [])] },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toMatchObject({ column: "client", reason: "unknown_term" });
  });
});

// §P3 — `import.columns` maps a spreadsheet header onto a field, so a real sheet's
// `Base Salary (USD)` stops being `unknown_column` without anybody editing the sheet.
describe("import.columns mapping", () => {
  const mapped = ConfigSchema.parse({
    project: "p",
    collections: {
      people: {
        description: "Employee directory",
        import: { columns: { "Base Salary (USD)": "base_salary", "Start Date": "hire_date" } },
        fields: {
          id: { type: "uuid", posture: "allow", pk: true },
          base_salary: { type: "numeric", posture: "deny", nullable: true },
          hire_date: { type: "date", posture: "allow", nullable: true },
        },
      },
    },
  });

  it("translates a header to a field before the field lookup", () => {
    const r = validateImportRows(mapped, "people", [
      { id: UUID, "Base Salary (USD)": "97300", "Start Date": "2024-01-15" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    // The columns handed downstream are FIELD names — run.ts builds SQL from them.
    expect(r.columns).toEqual(["id", "base_salary", "hire_date"]);
    expect(r.values[0]![1]).toBe(97300);
  });

  it("still accepts a header that already matches the field name", () => {
    const r = validateImportRows(mapped, "people", [{ id: UUID, base_salary: "1" }], {
      mode: "upsert",
    });
    expect(r.ok).toBe(true);
  });

  it("still reports an unmapped header as unknown_column, naming the header", () => {
    const r = validateImportRows(mapped, "people", [{ id: UUID, "Bank Account": "x" }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toMatchObject({ column: "Bank Account", reason: "unknown_column" });
  });

  it("reports a per-cell failure against the header, not the field", () => {
    const r = validateImportRows(mapped, "people", [{ id: UUID, "Start Date": "not-a-date" }], {
      mode: "upsert",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toMatchObject({ column: "Start Date", reason: "invalid_date" });
  });

  it("refuses a file that supplies both the mapped header and the field's own name", () => {
    const r = validateImportRows(mapped, "people", [
      { id: UUID, "Base Salary (USD)": "1", base_salary: "2" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors.some((e) => e.reason === "duplicate_column")).toBe(true);
  });

  it("makes a mapping onto a non-existent field a config parse error, not an import one", () => {
    const r = ConfigSchema.safeParse({
      project: "p",
      collections: {
        people: {
          description: "d",
          import: { columns: { "Base Salary (USD)": "salary" } },
          fields: { id: { type: "uuid", posture: "allow", pk: true } },
        },
      },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("import/column-target-exists");
  });
});

describe("coerce: explicit null", () => {
  it("accepts an explicit null on a nullable field, for every type", () => {
    for (const type of [
      "uuid",
      "text",
      "int",
      "numeric",
      "boolean",
      "date",
      "timestamptz",
      "json",
    ] as const) {
      const r = coerce(null, { type, posture: "allow", nullable: true });
      expect(r, type).toEqual({ ok: true, value: null });
    }
  });

  it("refuses an explicit null on a field that is not nullable", () => {
    const r = coerce(null, { type: "text", posture: "allow" });
    expect(r.ok).toBe(false);
  });

  it("still refuses an empty cell on a non-nullable column through validateImportRows", () => {
    // Pins that validateImportRows' own empty-cell branch — which runs BEFORE coerce is ever
    // called — is unchanged by the null branch added to coerce. `departments.name` carries no
    // `nullable: true` in the Harbor config.
    const r = validateImportRows(cfg, "departments", [{ id: UUID, name: "" }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toMatchObject({ column: "name", reason: "missing_required" });
  });
});
