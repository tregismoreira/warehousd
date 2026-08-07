// Spreadsheets, as far as the broker is concerned.
//
// The broker declares the shape and does the import semantics — which sheet, which header row,
// what a header maps to. It does not parse a workbook: that needs a ZIP reader and an XML reader,
// and `packages/broker` is meant to stay thin. The implementation lives in @warehousd/providers
// beside the PDF and DOCX extractors and is injected exactly the way `BinaryExtractor` is.

/** One worksheet, as a rectangular grid of already-stringified cells. Blank cells are `""`. */
export type SheetGrid = {
  name: string;
  /**
   * Every row, padded to the widest. Emptiness is DERIVED rather than declared: a reader that had
   * to report `hasData` itself would be a second place the rule "a blank sheet is not a candidate
   * for import" could be spelled differently.
   */
  rows: string[][];
};

export type SheetReader = {
  /** Every sheet in the workbook, in workbook order. */
  read(bytes: Uint8Array): SheetGrid[];
};

/** A workbook that cannot be turned into one unambiguous table. Never carries a cell value. */
export class SheetSelectionError extends Error {
  constructor(
    message: string,
    readonly sheets: string[] = [],
  ) {
    super(message);
    this.name = "SheetSelectionError";
  }
}

export type SheetOptions = {
  /** Which sheet to import. Required when more than one sheet has data. */
  sheet?: string | undefined;
  /** 1-based row the headers are on. Default 1. A title row above the table is common. */
  headerRow?: number | undefined;
};

const hasContent = (row: string[]): boolean => row.some((c) => c.trim() !== "");

/**
 * Pick the one sheet to import from.
 *
 * **Ambiguity is refused, never resolved.** Silently taking the first sheet of a workbook that has
 * three is how a quarter of someone's data goes missing without an error — and the person running
 * the import is the one person who knows which sheet is the real one. A workbook with exactly one
 * sheet holding data needs no flag, because there is nothing to be ambiguous about.
 */
export function selectSheet(grids: SheetGrid[], sheet?: string): SheetGrid {
  const named = grids.map((g) => g.name);
  if (sheet !== undefined) {
    const found = grids.find((g) => g.name === sheet);
    if (!found) throw new SheetSelectionError(`the workbook has no sheet named "${sheet}"`, named);
    return found;
  }
  const withData = grids.filter((g) => g.rows.some(hasContent));
  if (withData.length === 0) throw new SheetSelectionError("the workbook has no data", named);
  if (withData.length > 1)
    throw new SheetSelectionError(
      `the workbook has ${withData.length} sheets with data — name one with --sheet`,
      withData.map((g) => g.name),
    );
  return withData[0]!;
}

/**
 * A sheet as import rows: the header row becomes the keys, everything below it becomes values.
 *
 * Headers are trimmed. A blank header is refused rather than named `column_3`, because a generated
 * name cannot be mapped in `import.columns` by anyone reading the spreadsheet. A duplicate header
 * is refused for the same reason `duplicate_column` exists — whichever cell lands last would win
 * silently.
 */
export function rowsFromSheet(grid: SheetGrid, opts: SheetOptions = {}): Record<string, string>[] {
  const headerRow = opts.headerRow ?? 1;
  if (!Number.isInteger(headerRow) || headerRow < 1)
    throw new SheetSelectionError(`--header-row must be a positive row number`);
  const header = grid.rows[headerRow - 1];
  if (!header || !hasContent(header))
    throw new SheetSelectionError(`sheet "${grid.name}" has no header on row ${headerRow}`, [
      grid.name,
    ]);

  // A trailing blank column is what a spreadsheet leaves behind when somebody deletes a column's
  // contents but not the column, so it is dropped rather than refused as a blank header.
  let width = header.length;
  while (width > 0 && (header[width - 1] ?? "").trim() === "") width--;
  const names = header.slice(0, width).map((h) => h.trim());

  if (names.some((h) => h === ""))
    throw new SheetSelectionError(
      `sheet "${grid.name}" has a blank header between two named columns on row ${headerRow}`,
      [grid.name],
    );
  const seen = new Set<string>();
  for (const h of names) {
    if (seen.has(h))
      throw new SheetSelectionError(`sheet "${grid.name}" has two columns named "${h}"`, [
        grid.name,
      ]);
    seen.add(h);
  }

  const out: Record<string, string>[] = [];
  for (const row of grid.rows.slice(headerRow)) {
    // A blank row inside the table is a separator someone added for readability; below the table
    // it is padding. Either way there is no document in it.
    if (!hasContent(row.slice(0, width))) continue;
    const rec: Record<string, string> = {};
    names.forEach((name, i) => {
      rec[name] = row[i] ?? "";
    });
    out.push(rec);
  }
  return out;
}
