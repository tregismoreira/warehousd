import { describe, it, expect } from "vitest";
import {
  selectSheet,
  rowsFromSheet,
  SheetSelectionError,
  type SheetGrid,
  type SheetReader,
} from "../src/import/sheet";
import { parseImport } from "../src/import/csv";

// §P3's XLSX half. The customer's data is `.xlsx`, and the things a workbook does that a CSV does
// not — several sheets, a header row that is not row 1, merged cells, formulas — are exactly the
// things a parser must not guess at.

const grid = (name: string, rows: string[][]): SheetGrid => ({ name, rows });

describe("selectSheet refuses ambiguity rather than resolving it", () => {
  it("takes the only sheet with data without being told", () => {
    const g = [grid("Data", [["a"], ["1"]]), grid("Notes", [[""], [""]])];
    expect(selectSheet(g).name).toBe("Data");
  });

  it("refuses a workbook with two populated sheets and no --sheet", () => {
    const g = [grid("Q1", [["a"], ["1"]]), grid("Q2", [["a"], ["2"]])];
    // Silently taking the first is how the wrong quarter's numbers land in production.
    expect(() => selectSheet(g)).toThrow(SheetSelectionError);
    expect(() => selectSheet(g)).toThrow(/2 sheets with data/);
  });

  it("names the sheets so the operator can pick one", () => {
    const g = [grid("Q1", [["a"], ["1"]]), grid("Q2", [["a"], ["2"]])];
    try {
      selectSheet(g);
      throw new Error("unreachable");
    } catch (e) {
      expect((e as SheetSelectionError).sheets).toEqual(["Q1", "Q2"]);
    }
  });

  it("takes the named sheet, populated or not", () => {
    const g = [grid("Q1", [["a"], ["1"]]), grid("Q2", [["a"], ["2"]])];
    expect(selectSheet(g, "Q2").rows[1]).toEqual(["2"]);
  });

  it("refuses a name the workbook does not have", () => {
    const g = [grid("Q1", [["a"], ["1"]])];
    expect(() => selectSheet(g, "Q3")).toThrow(/no sheet named "Q3"/);
  });

  it("refuses a workbook with nothing in it at all", () => {
    expect(() => selectSheet([grid("Sheet1", [[""]])])).toThrow(SheetSelectionError);
  });
});

describe("rowsFromSheet", () => {
  it("takes row 1 as the header by default", () => {
    const g = grid("s", [
      ["name", "dept"],
      ["Ana", "Legal"],
    ]);
    expect(rowsFromSheet(g)).toEqual([{ name: "Ana", dept: "Legal" }]);
  });

  it("honours --header-row for a sheet with a title block above the table", () => {
    const g = grid("s", [
      ["Q1 headcount — CONFIDENTIAL", ""],
      ["", ""],
      ["name", "dept"],
      ["Ana", "Legal"],
    ]);
    expect(rowsFromSheet(g, { headerRow: 3 })).toEqual([{ name: "Ana", dept: "Legal" }]);
  });

  it("refuses a header row past the end of the sheet", () => {
    const g = grid("s", [["name"], ["Ana"]]);
    expect(() => rowsFromSheet(g, { headerRow: 9 })).toThrow(SheetSelectionError);
  });

  it("refuses a blank header BETWEEN named columns rather than inventing a name", () => {
    // A generated `column_2` cannot be mapped in `import.columns` by anyone reading the sheet.
    const g = grid("s", [
      ["name", "", "dept"],
      ["Ana", "x", "Legal"],
    ]);
    expect(() => rowsFromSheet(g)).toThrow(SheetSelectionError);
  });

  it("drops a TRAILING blank header — a deleted column's leftovers, not a missing name", () => {
    const g = grid("s", [
      ["name", ""],
      ["Ana", ""],
    ]);
    expect(rowsFromSheet(g)).toEqual([{ name: "Ana" }]);
  });

  it("refuses a duplicate header rather than letting one column win", () => {
    const g = grid("s", [
      ["name", "name"],
      ["Ana", "Bo"],
    ]);
    expect(() => rowsFromSheet(g)).toThrow(SheetSelectionError);
  });

  it("pads a short row so a trailing empty cell is a missing value, not a ragged row", () => {
    const g = grid("s", [["name", "dept"], ["Ana"]]);
    expect(rowsFromSheet(g)).toEqual([{ name: "Ana", dept: "" }]);
  });

  it("drops blank rows below the table", () => {
    const g = grid("s", [["name"], ["Ana"], [""], [""]]);
    expect(rowsFromSheet(g)).toEqual([{ name: "Ana" }]);
  });
});

describe("parseImport", () => {
  // The reader is INJECTED: a workbook parser is a dependency the broker does not take
  // (invariant 1 keeps it thin), so the CLI and the web route supply one.
  const reader: SheetReader = {
    read: () => [
      grid("People", [
        // A merged cell arrives as its value in the first position and blanks after it; a formula
        // cell arrives as its CACHED value, which is what the parser is asked to hand over.
        ["name", "dept", "band"],
        ["Ana", "Legal", "75000"],
        ["Bo", "", "75000"],
      ]),
    ],
  };

  it("reads a workbook through the injected reader", () => {
    const rows = parseImport(
      { format: "xlsx", bytes: new Uint8Array([1, 2, 3]) },
      {
        sheets: reader,
      },
    );
    expect(rows).toEqual([
      { name: "Ana", dept: "Legal", band: "75000" },
      // The blank half of a merged cell is a blank value, which import validation then treats as
      // missing — the same as an empty CSV cell.
      { name: "Bo", dept: "", band: "75000" },
    ]);
  });

  it("refuses xlsx with no reader supplied, by name", () => {
    // Rather than silently falling back to CSV, which would report every row as ragged.
    expect(() => parseImport({ format: "xlsx", bytes: new Uint8Array([1]) }, {})).toThrow(/XLSX/i);
  });

  it("still reads csv and json without one", () => {
    expect(parseImport({ format: "csv", text: "a,b\n1,2" }, {})).toEqual([{ a: "1", b: "2" }]);
    expect(parseImport({ format: "json", text: `[{"a":1}]` }, {})).toEqual([{ a: 1 }]);
  });
});
