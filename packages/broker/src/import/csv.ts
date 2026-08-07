// RFC 4180 subset: comma-delimited, double-quote escaping, quoted fields may contain
// commas and newlines, CRLF tolerated. No custom delimiters, no comment lines — an import
// file is a spreadsheet export, not a config format.
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ",") {
      endField();
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) endRow();

  // Drop trailing blank lines (a single empty cell from a final newline).
  while (rows.length && rows[rows.length - 1]!.every((c) => c === "")) rows.pop();
  if (rows.length === 0) throw new Error("CSV document is empty");

  const header = rows[0]!.map((h) => h.trim());
  return rows.slice(1).map((r, n) => {
    if (r.length !== header.length)
      throw new Error(
        `CSV row ${n + 1} has a column count of ${r.length}, header has ${header.length}`,
      );
    return Object.fromEntries(header.map((h, k) => [h, r[k]!]));
  });
}

import { rowsFromSheet, selectSheet, type SheetOptions, type SheetReader } from "./sheet";

/** Everything an import can arrive as. `xlsx` is bytes; the other two are text. */
export type ImportPayload =
  { format: "csv" | "json"; text: string } | ({ format: "xlsx"; bytes: Uint8Array } & SheetOptions);

export const IMPORT_FORMATS = ["csv", "json", "xlsx"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/**
 * A payload as rows.
 *
 * `xlsx` needs a `SheetReader`, which is injected rather than constructed: a workbook parser is a
 * ZIP reader and an XML reader, and `packages/broker` is meant to stay thin. Without one the
 * format is refused by name rather than silently falling back to CSV — see import/sheet.ts.
 */
export function parseImport(
  payload: ImportPayload,
  opts: { sheets?: SheetReader | undefined } = {},
): Record<string, unknown>[] {
  if (payload.format !== "xlsx") return parseImportPayload(payload.text, payload.format);
  if (!opts.sheets) throw new Error("XLSX import needs a sheet reader, and none was configured");
  const grids = opts.sheets.read(payload.bytes);
  return rowsFromSheet(selectSheet(grids, payload.sheet), payload);
}

export function parseImportPayload(
  text: string,
  format: "csv" | "json",
): Record<string, unknown>[] {
  if (format === "csv") return parseCsv(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Could not parse JSON payload");
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { rows?: unknown }).rows)
      ? (parsed as { rows: unknown[] }).rows
      : null;
  if (!rows) throw new Error('JSON payload must be an array of rows or {"rows": [...]}');
  return rows as Record<string, unknown>[];
}
