import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../src/config/schema";
import { validateImportRows, summarizeImportErrors } from "../src/import/validate";
import { reportImportSummary, formatImportReport } from "../src/import/report";

// §P11a. `MAX_ERRORS` truncates the detail list at 50, so a 10,000-row sheet used to report the
// first fifty row numbers and nothing about the shape of the problem. These pin the aggregation
// that replaced it — and the rule that made the truncation tolerable in the first place: an error
// never carries a cell value.

const cfg = ConfigSchema.parse({
  project: "test",
  taxonomies: { department: { label: "Department", terms: { legal: { label: "Legal" } } } },
  collections: {
    people: {
      description: "People",
      taxonomies: ["department"],
      fields: {
        id: { type: "uuid", posture: "allow", pk: true },
        hire_date: { type: "date", posture: "allow" },
        email: { type: "text", posture: "allow" },
        department: { posture: "allow" },
      },
    },
  },
});

const uuid = (n: number) => `3f8b0e4a-1c2d-4e5f-8a9b-${String(n).padStart(12, "0")}`;

// One row per problem class the plan names, with values chosen to be recognisable if they ever
// leaked: a date, an address, a salary, a term.
function sheet(rows: number): Record<string, unknown>[] {
  return Array.from({ length: rows }, (_, i) => ({
    id: uuid(i),
    hire_date: i % 2 === 0 ? "xx-SPILL-xx" : "2024-01-15",
    email: "canary@spill.example",
    department: i % 5 === 0 ? "SPILL-Legal Ops" : "legal",
  }));
}

describe("aggregated counts are complete, not truncated", () => {
  it("counts every affected row even past MAX_ERRORS", () => {
    const r = validateImportRows(cfg, "people", sheet(400));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");

    // The detail list is still capped — nobody reads more than fifty.
    expect(r.errors.length).toBe(50);

    const dates = r.summary.groups.find((g) => g.reason === "invalid_date");
    const terms = r.summary.groups.find((g) => g.reason === "unknown_term");
    // 200 even rows have a bad date; 80 rows divisible by 5 have a bad term.
    expect(dates).toMatchObject({ column: "hire_date", count: 200, scope: "row" });
    expect(terms).toMatchObject({ column: "department", count: 80, scope: "row" });
    // Rows are counted once even when two columns are wrong on the same row.
    expect(r.summary.rowsTotal).toBe(400);
    expect(r.summary.rowsAffected).toBe(240);
    expect(r.summary.columnsTotal).toBe(4);
  });

  it("names the first affected row, 1-based, in the report", () => {
    const r = validateImportRows(cfg, "people", sheet(10));
    if (r.ok) throw new Error("unreachable");
    const report = reportImportSummary(r.summary);
    const dates = report.lines.find((l) => l.reason === "invalid_date");
    // Row index 0 is the first data row, which a spreadsheet calls row 1.
    expect(dates?.firstRow).toBe(1);
    expect(dates?.extent).toBe("5 rows");
  });

  it("says how many rows are ready", () => {
    const r = validateImportRows(cfg, "people", sheet(10));
    if (r.ok) throw new Error("unreachable");
    // Rows 0,2,4,6,8 have a bad date and 0,5 have a bad term — six distinct rows in all.
    expect(reportImportSummary(r.summary).footer).toBe("4 of 10 rows are ready to import.");
  });
});

describe("scopes are told apart", () => {
  it("a bad column is one column, not one row", () => {
    const r = validateImportRows(cfg, "people", [{ id: uuid(1), "Base Salary (USD)": "97300" }]);
    if (r.ok) throw new Error("unreachable");
    expect(r.summary.groups).toEqual([
      {
        column: "Base Salary (USD)",
        reason: "unknown_column",
        scope: "column",
        count: 1,
        firstRow: null,
      },
    ]);
    const report = reportImportSummary(r.summary);
    expect(report.headline).toBe("1 of 2 columns will not import");
    // A bad column stops every row, so there is no "rows are ready" count to give.
    expect(report.footer).toBeNull();
    expect(report.lines[0]?.hint).toContain("warehousd import map");
  });

  it("a whole-file refusal says so", () => {
    const r = validateImportRows(cfg, "nope", [{ id: uuid(1) }]);
    if (r.ok) throw new Error("unreachable");
    expect(r.summary.groups[0]).toMatchObject({ scope: "file", reason: "unknown_collection" });
    expect(reportImportSummary(r.summary).headline).toBe("This file cannot be imported.");
  });
});

// The half of §P11a that matters most. validate.ts keeps values out of errors on purpose, and a
// terminal is as much a place a value can leak as a response body is.
describe("no cell value appears anywhere in the output", () => {
  it("not in the errors, the summary, or the formatted report", () => {
    const r = validateImportRows(cfg, "people", sheet(120));
    if (r.ok) throw new Error("unreachable");
    const everything = [
      JSON.stringify(r.errors),
      JSON.stringify(r.summary),
      formatImportReport(r.summary),
    ].join("\n");
    expect(everything).not.toContain("SPILL");
    expect(everything).not.toContain("canary@spill.example");
    expect(everything).not.toContain("2024-01-15");
  });
});

describe("summarizeImportErrors over a bare array", () => {
  // The shape a caller has when all it holds is `ImportResult.errors` over HTTP.
  it("groups the same way the validator's own tally does", () => {
    const errors = [
      { row: 4, column: "hire_date", reason: "invalid_date", scope: "row" as const },
      { row: 2, column: "hire_date", reason: "invalid_date", scope: "row" as const },
      { row: 2, column: "email", reason: "missing_required", scope: "row" as const },
    ];
    const s = summarizeImportErrors(errors, 10, 3);
    expect(s.groups[0]).toMatchObject({ column: "hire_date", count: 2, firstRow: 2 });
    expect(s.rowsAffected).toBe(2);
    expect(reportImportSummary(s).headline).toBe("2 of 10 rows will not import");
  });
});
