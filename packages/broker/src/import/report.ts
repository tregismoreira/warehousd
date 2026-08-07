import type { ImportErrorGroup, ImportErrorSummary } from "./validate";

// Re-exported so a consumer can have the summary type and the renderer from ONE import.
//
// That matters because this module is also the package's `@warehousd/broker/import-report`
// subpath, and the reason the subpath exists is the browser: `/admin/import` renders this report
// in a `"use client"` component, and reaching it through the package barrel drags `db/pools.ts`
// and therefore `pg` into the client bundle — which fails the build on `dns`, `fs`, `net` and
// `tls`. Everything here is pure, and every import above is `import type`, so nothing runtime
// crosses the boundary.
export type { ImportError, ImportErrorGroup, ImportErrorSummary } from "./validate";

// How an import failure is EXPLAINED, in one place, for both surfaces that explain it.
//
// The CLI prints these as text and `/admin/import` renders them as a panel, but the grouping, the
// counts, the wording of each reason and the "here is what to do" hint are all decided here. This
// is the same argument grants/manage.ts already makes about validation — "a rule enforced in only
// one of them is not a rule" — applied to how a failure is described: an admin who fixes a sheet
// from the web panel and a dev who fixes it from CI should be reading the same summary.
//
// Nothing here has ever seen a cell value, and nothing here may start. `ImportError` carries a
// reason code and a column name on purpose (validate.ts), and a terminal is as much a place a
// value can leak as a response body is.

/** The human phrasing of each reason code. Unknown codes fall back to the code itself. */
export const IMPORT_ERROR_LABELS: Record<string, string> = {
  // Whole-file
  unknown_collection: "no such collection",
  file_collection: "this is a file collection — it is ingested by the indexer, not imported",
  too_many_rows: "too many rows for one import",
  no_rows: "the file has no data rows",
  // Column
  unknown_column: "no field of this name on the collection",
  duplicate_column: "two headers land on the same field",
  derived_column: "a view_join field, resolved from another table and not stored here",
  unvalidatable_term: "its vocabulary is dataset-sourced and cannot be checked offline",
  no_primary_key: "this collection declares no primary key to address documents by",
  // Cell
  missing_required: "required value missing",
  ragged_rows: "this row has a different number of cells than the header",
  unknown_term: "not a term in the bound vocabulary",
  duplicate_pk: "duplicate primary key in this file",
  not_found: "no document with this primary key",
  invalid_uuid: "not a UUID",
  invalid_int: "not a whole number",
  invalid_numeric: "not a number",
  invalid_boolean: "not a true/false value",
  invalid_date: "not a date",
  invalid_json: "not valid JSON",
  invalid_text: "not text",
  // Whole-run, from importCollection rather than validation
  constraint_violation: "conflicts with data already in the collection",
  taxonomy_unavailable: "the term store could not be read",
};

export function importErrorLabel(reason: string): string {
  return IMPORT_ERROR_LABELS[reason] ?? reason;
}

/** What a reader should do about a given reason, where there is a useful answer. */
const HINTS: Record<string, string> = {
  unknown_column: "map it with `import.columns`, or run `warehousd import map`",
  duplicate_column: "drop one of the two headers, or the `import.columns` entry",
  unvalidatable_term: "re-run with --live, which can read the term store",
  derived_column: "remove the column from the file",
  ragged_rows: "the row is malformed — check for an unescaped comma or quote",
};

export type ImportReportLine = {
  column: string | null;
  reason: string;
  label: string;
  /** "97 rows", "1 column", "whole file". */
  extent: string;
  /** 1-based data row number, so it matches what a spreadsheet shows. Null off the row scope. */
  firstRow: number | null;
  hint: string | null;
};

export type ImportReport = {
  /** One sentence naming the size of the problem. */
  headline: string;
  lines: ImportReportLine[];
  /** "6,209 of 6,351 rows are ready to import." — only where that is knowable. */
  footer: string | null;
};

function extentOf(g: ImportErrorGroup): string {
  if (g.scope === "file") return "whole file";
  if (g.scope === "column") return "1 column";
  return `${g.count.toLocaleString("en-US")} ${g.count === 1 ? "row" : "rows"}`;
}

/**
 * Group counts and headline, aggregated rather than listed.
 *
 * `MAX_ERRORS` truncates the error array at 50, and against a 10,000-row sheet fifty row numbers
 * tells you almost nothing about what is wrong — you need "hire_date, 97 rows", not the first
 * fifty of them. The counts on the summary are complete (see validate.ts), so this can say so.
 */
export function reportImportSummary(summary: ImportErrorSummary): ImportReport {
  const lines: ImportReportLine[] = summary.groups.map((g) => ({
    column: g.column,
    reason: g.reason,
    label: importErrorLabel(g.reason),
    extent: extentOf(g),
    // Stored 0-based; shown 1-based, because nobody counts their spreadsheet from zero.
    firstRow: g.firstRow === null ? null : g.firstRow + 1,
    hint: HINTS[g.reason] ?? null,
  }));

  const n = (x: number) => x.toLocaleString("en-US");
  const scopes = new Set(summary.groups.map((g) => g.scope));

  let headline: string;
  if (scopes.has("file")) {
    headline = "This file cannot be imported.";
  } else if (scopes.has("column")) {
    headline =
      summary.columnsTotal === null
        ? `${n(summary.columnsAffected)} column(s) will not import`
        : `${n(summary.columnsAffected)} of ${n(summary.columnsTotal)} columns will not import`;
  } else {
    headline =
      summary.rowsTotal === null
        ? `${n(summary.rowsAffected)} row(s) will not import`
        : `${n(summary.rowsAffected)} of ${n(summary.rowsTotal)} rows will not import`;
  }

  // Only meaningful for a row-scoped failure. A bad column stops every row, so "6,209 rows are
  // ready" would be false — and an import is all-or-nothing anyway, so this is a measure of how
  // much work is left, not a promise about a partial run.
  const footer =
    !scopes.has("file") && !scopes.has("column") && summary.rowsTotal !== null
      ? `${n(summary.rowsTotal - summary.rowsAffected)} of ${n(summary.rowsTotal)} rows are ready to import.`
      : null;

  return { headline, lines, footer };
}

/**
 * The report as plain text, for a terminal. Padded into columns so the eye tracks one edge down
 * the page, which is the same reason packages/cli/src/ui/reporter.ts right-aligns its verb gutter.
 */
export function formatImportReport(summary: ImportErrorSummary): string {
  const r = reportImportSummary(summary);
  if (r.lines.length === 0) return r.headline;

  const colWidth = Math.min(24, Math.max(...r.lines.map((l) => (l.column ?? "—").length)));
  const labelWidth = Math.min(44, Math.max(...r.lines.map((l) => l.label.length)));
  const clip = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s.padEnd(w));

  const body = r.lines.map((l) => {
    const where = l.firstRow === null ? "" : `  (first: row ${l.firstRow})`;
    const hint = l.hint ? `  → ${l.hint}` : "";
    return `  ${clip(l.column ?? "—", colWidth)}  ${clip(l.label, labelWidth)}  ${l.extent.padStart(9)}${where}${hint}`;
  });

  return [`✗ ${r.headline}`, "", ...body, ...(r.footer ? ["", `  ${r.footer}`] : [])].join("\n");
}
