import { describe, it, expect } from "vitest";
import {
  ExtractionFailed,
  rowsFromSheet,
  selectSheet,
  SheetSelectionError,
} from "@warehousd/broker";
import { makeSheetReader } from "../src/sheet";
import { buildXlsx, text, num, date, formula, inline } from "./helpers/xlsx";

// §P3c. The four things the plan says an XLSX reader must not guess at — which sheet, where the
// header is, merged cells, formula cells — plus the date question, which is the one that silently
// corrupts data rather than failing.

const reader = makeSheetReader();

describe("reading a workbook", () => {
  it("reads shared strings, inline strings and numbers", () => {
    const wb = buildXlsx([
      {
        name: "People",
        rows: [
          [text("name"), text("dept"), text("headcount")],
          [text("Ana"), inline("Legal"), num(3)],
        ],
      },
    ]);
    const grids = reader.read(wb);
    expect(grids).toHaveLength(1);
    expect(grids[0]?.name).toBe("People");
    expect(grids[0]?.rows[1]).toEqual(["Ana", "Legal", "3"]);
  });

  it("takes a formula cell's cached value and never the formula", () => {
    const wb = buildXlsx([{ name: "S", rows: [[text("dept")], [formula("LEGAL")]] }]);
    const rows = reader.read(wb)[0]!.rows;
    expect(rows[1]).toEqual(["LEGAL"]);
    expect(JSON.stringify(rows)).not.toContain("UPPER");
  });

  it("leaves the rest of a merged range empty rather than repeating the value", () => {
    // Excel stores a merged range's value in the top-left cell and omits the rest entirely.
    const wb = buildXlsx([
      {
        name: "S",
        rows: [
          [text("region"), text("city")],
          [text("South"), text("Belo Horizonte")],
          [null, text("Ouro Preto")],
        ],
      },
    ]);
    const rows = reader.read(wb)[0]!.rows;
    expect(rows[2]?.[0] ?? "").toBe("");
    expect(rows[2]?.[1]).toBe("Ouro Preto");
  });

  it("turns a date-formatted number into an ISO date, not a serial", () => {
    // 45306 is 2024-01-15 under Excel's 1900 epoch, leap-year bug included.
    const wb = buildXlsx([{ name: "S", rows: [[text("hired")], [date(45306)]] }]);
    expect(reader.read(wb)[0]!.rows[1]).toEqual(["2024-01-15"]);
  });

  it("leaves an unformatted number alone", () => {
    const wb = buildXlsx([{ name: "S", rows: [[text("n")], [num(45306)]] }]);
    expect(reader.read(wb)[0]!.rows[1]).toEqual(["45306"]);
  });

  it("refuses a file that is not a zip", () => {
    expect(() => reader.read(new TextEncoder().encode("id,name\n1,Ana"))).toThrow(ExtractionFailed);
  });
});

describe("selectSheet refuses ambiguity rather than picking the first", () => {
  const twoSheets = buildXlsx([
    { name: "People", rows: [[text("id")], [text("1")]] },
    { name: "Departments", rows: [[text("id")], [text("2")]] },
  ]);

  it("refuses a multi-sheet workbook with no --sheet", () => {
    const grids = reader.read(twoSheets);
    expect(() => selectSheet(grids)).toThrow(SheetSelectionError);
    try {
      selectSheet(grids);
    } catch (e) {
      // The message has to name them, or "pick one" is not actionable.
      expect((e as SheetSelectionError).sheets).toEqual(["People", "Departments"]);
    }
  });

  it("takes the named sheet", () => {
    expect(selectSheet(reader.read(twoSheets), "Departments").name).toBe("Departments");
  });

  it("refuses a name that is not in the workbook", () => {
    expect(() => selectSheet(reader.read(twoSheets), "Nope")).toThrow(/no sheet named/);
  });

  it("needs no flag when only one sheet has data", () => {
    const wb = buildXlsx([
      { name: "Notes", rows: [] },
      { name: "People", rows: [[text("id")], [text("1")]] },
    ]);
    expect(selectSheet(reader.read(wb)).name).toBe("People");
  });
});

describe("rowsFromSheet", () => {
  const wb = buildXlsx([
    {
      name: "People",
      rows: [
        [text("Q1 headcount — do not edit")],
        [text("Full Name"), text("Base Salary (USD)")],
        [text("Ana"), num(97300)],
        [],
        [text("Bruno"), num(88000)],
      ],
    },
  ]);

  it("honours --header-row", () => {
    const rows = rowsFromSheet(selectSheet(reader.read(wb)), { headerRow: 2 });
    expect(rows).toEqual([
      { "Full Name": "Ana", "Base Salary (USD)": "97300" },
      { "Full Name": "Bruno", "Base Salary (USD)": "88000" },
    ]);
  });

  it("skips blank rows inside the table", () => {
    expect(rowsFromSheet(selectSheet(reader.read(wb)), { headerRow: 2 })).toHaveLength(2);
  });

  it("refuses a header row that is not there", () => {
    expect(() => rowsFromSheet(selectSheet(reader.read(wb)), { headerRow: 99 })).toThrow(
      /no header on row 99/,
    );
  });

  it("refuses two columns with the same header", () => {
    const dup = buildXlsx([
      {
        name: "S",
        rows: [
          [text("id"), text("id")],
          [text("1"), text("2")],
        ],
      },
    ]);
    expect(() => rowsFromSheet(selectSheet(reader.read(dup)))).toThrow(/two columns named/);
  });

  it("refuses a blank header between two named columns", () => {
    const gap = buildXlsx([
      {
        name: "S",
        rows: [
          [text("id"), null, text("name")],
          [text("1"), text("x"), text("Ana")],
        ],
      },
    ]);
    expect(() => rowsFromSheet(selectSheet(reader.read(gap)))).toThrow(/blank header/);
  });

  it("ignores a trailing empty column left behind by a deleted one", () => {
    const trailing = buildXlsx([
      {
        name: "S",
        rows: [
          [text("id"), text("name"), inline("")],
          [text("1"), text("Ana"), null],
        ],
      },
    ]);
    expect(rowsFromSheet(selectSheet(reader.read(trailing)))).toEqual([{ id: "1", name: "Ana" }]);
  });
});
