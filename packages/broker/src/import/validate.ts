import type { WarehousdConfig, FieldConfig } from "../config/schema";
import { kindOf } from "../config/kinds";
import { findCollection } from "../config/load";
import type { TaxonomyBinding } from "../taxonomy";

/**
 * What went wrong, where — and never what the value was. An import file may hold real personal
 * data, and an error body is still a response body (invariant 4's discipline).
 *
 * `scope` says what `row` means, because it has never meant one thing:
 *
 *   - `file`   — the whole payload is wrong (`row: -1`). Unknown collection, too many rows.
 *   - `column` — a column is wrong for every row, so `row` is 0 and carries no information.
 *                Unknown header, a derived column, a missing required column.
 *   - `row`    — one cell in one row. `row` is a 0-based index into the payload.
 *
 * Aggregation has to tell those apart — "97 rows" and "1 column" are different sentences — and
 * inferring it from the reason code was guesswork, because `missing_required` is emitted by both
 * the column pass and the cell pass.
 */
export type ImportErrorScope = "file" | "column" | "row";
export type ImportError = {
  row: number;
  column: string | null;
  reason: string;
  scope: ImportErrorScope;
};

/**
 * One (column, reason) pair and how much of the file it accounts for.
 *
 * `MAX_ERRORS` truncates `errors` at 50, which against a 10,000-row sheet tells you almost
 * nothing: fifty row numbers is not a diagnosis. The counts here are complete — they are tallied
 * as the file is validated rather than recovered from the truncated list — so a report can say
 * "97 rows" without the cap being raised and without 10,000 error objects being built.
 */
export type ImportErrorGroup = {
  column: string | null;
  reason: string;
  scope: ImportErrorScope;
  /** Rows affected, for `scope: "row"`. 1 for a column- or file-scoped problem. */
  count: number;
  /** 0-based index of the first affected row, or null where the scope is not a row. */
  firstRow: number | null;
};

export type ImportErrorSummary = {
  /** Most-affected first, so the biggest problem is the first line of the report. */
  groups: ImportErrorGroup[];
  /** Distinct columns named by at least one group. */
  columnsAffected: number;
  /** Distinct rows with at least one problem. */
  rowsAffected: number;
  /** Rows in the payload, where the failure got far enough for that to be known. */
  rowsTotal: number | null;
  /** Headers in the payload, once they have been read. Null on a whole-file refusal. */
  columnsTotal: number | null;
};

/**
 * The aggregation both surfaces render from — the CLI's report layer and `/admin/import`'s error
 * panel. It is here, next to `ImportError`, for the reason grants/manage.ts already gives about
 * validation: "a rule enforced in only one of them is not a rule". An admin who fixes a sheet from
 * the web panel and a dev who fixes it from CI should be reading the same summary.
 *
 * Use it when all you hold is the array — `ImportResult.errors` over HTTP, say. When the
 * validation result itself is in hand, prefer its `summary`: this one can only count the errors
 * that survived truncation.
 */
export function summarizeImportErrors(
  errors: readonly ImportError[],
  rowsTotal: number | null = null,
  columnsTotal: number | null = null,
): ImportErrorSummary {
  const groups = new Map<string, ImportErrorGroup>();
  const rows = new Set<number>();
  for (const e of errors) {
    // A JSON tuple, not a delimiter-joined string: a header may contain whatever a
    // spreadsheet let somebody type, and two different (column, reason) pairs collapsing
    // into one group would silently under-report a column.
    const key = JSON.stringify([e.scope, e.column, e.reason]);
    const g = groups.get(key);
    if (g) {
      g.count += 1;
      if (e.scope === "row" && (g.firstRow === null || e.row < g.firstRow)) g.firstRow = e.row;
    } else {
      groups.set(key, {
        column: e.column,
        reason: e.reason,
        scope: e.scope,
        count: 1,
        firstRow: e.scope === "row" ? e.row : null,
      });
    }
    if (e.scope === "row") rows.add(e.row);
  }
  return finishSummary([...groups.values()], rows.size, rowsTotal, columnsTotal);
}

// Sort and count, shared by the truncated-array path above and the complete tally below so the two
// can never order or total differently.
function finishSummary(
  groups: ImportErrorGroup[],
  rowsAffected: number,
  rowsTotal: number | null,
  columnsTotal: number | null,
): ImportErrorSummary {
  groups.sort((a, b) => b.count - a.count || (a.column ?? "").localeCompare(b.column ?? ""));
  const columns = new Set(groups.map((g) => g.column).filter((c): c is string => c !== null));
  return { groups, columnsAffected: columns.size, rowsAffected, rowsTotal, columnsTotal };
}

// A refusal about the whole payload rather than about a column or a row: the collection does not
// exist, it is the wrong kind, the file is empty or too big. `row: -1` is the long-standing
// convention for "this is not about a row"; `scope` is what makes that legible.
function fileError(reason: string): ImportValidation {
  const errors: ImportError[] = [{ row: -1, column: null, reason, scope: "file" }];
  return { ok: false, errors, summary: summarizeImportErrors(errors) };
}

export type ImportPlan = { columns: string[]; values: unknown[][] };
export type ImportValidation =
  | { ok: true; columns: string[]; values: unknown[][] }
  | { ok: false; errors: ImportError[]; summary: ImportErrorSummary };

const MAX_ERRORS = 50;
const DEFAULT_MAX_ROWS = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Coerce one cell to its declared type, or return a reason code. CSV delivers everything as
// a string, so the numeric/boolean/date branches must accept string input.
//
// Errors carry a reason code and never the value: an import file may hold real personal
// data, and an error body is still a response body (invariant 4's discipline).
export function coerce(
  v: unknown,
  f: FieldConfig,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  // `nullable: true` is what lets a column hold nothing. A write payload that spells that absence
  // as an explicit `null` means the same thing and is accepted as the same thing — every generated
  // client serialises an absent optional value that way. Before this branch each type fell through
  // to its own parser, where `Number("null")` is NaN and `typeof null === "string"` is false, so a
  // nullable field refused the one value it was declared to hold. Only the import path escaped it,
  // because validateImportRows tests for an empty cell before calling here.
  //
  // It comes before the switch, not inside it, because `typeof null === "object"` — the json branch
  // would otherwise catch a null and store the four-character jsonb document `null`.
  if (v === null || v === undefined) {
    return f.nullable ? { ok: true, value: null } : { ok: false, reason: "null_not_allowed" };
  }
  // The check above narrows `v`'s TYPE from `unknown` to `{}` — TypeScript's shorthand for
  // "anything but null or undefined" — which no-base-to-string reads as an object offering only
  // Object's default toString. Nothing changed at RUNTIME: `v` could hold an object here exactly
  // as much as it could before this branch existed, same as the json case below already disables.
  switch (f.type) {
    case "uuid":
      return typeof v === "string" && UUID_RE.test(v)
        ? { ok: true, value: v }
        : { ok: false, reason: "invalid_uuid" };
    case "int": {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (!Number.isInteger(n)) return { ok: false, reason: "invalid_int" };
      return { ok: true, value: n };
    }
    case "numeric": {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (!Number.isFinite(n)) return { ok: false, reason: "invalid_numeric" };
      return { ok: true, value: n };
    }
    case "boolean": {
      if (typeof v === "boolean") return { ok: true, value: v };
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const s = String(v).trim().toLowerCase();
      if (["true", "t", "1", "yes"].includes(s)) return { ok: true, value: true };
      if (["false", "f", "0", "no"].includes(s)) return { ok: true, value: false };
      return { ok: false, reason: "invalid_boolean" };
    }
    case "date": {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const t = Date.parse(String(v));
      if (Number.isNaN(t)) return { ok: false, reason: "invalid_date" };
      // A `date` field is a calendar day, so the value bound for it is one. Postgres truncates the
      // instant form to the same day, so nothing about what is STORED changes; what changes is what
      // the value is in this process. canonicalize() reads a date as a calendar day and returns null
      // for an instant, so the post-image of a write that stated a date field could not be matched
      // by a date filter — and a grant scoped by one would refuse every such write.
      // indexing/extract.ts already coerces a date this way; this is the two coercers agreeing.
      return { ok: true, value: new Date(t).toISOString().slice(0, 10) };
    }
    case "timestamptz": {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const t = Date.parse(String(v));
      if (Number.isNaN(t)) return { ok: false, reason: "invalid_date" };
      return { ok: true, value: new Date(t).toISOString() };
    }
    case "json": {
      // Returned as a JS VALUE, not as text. The revision writer renders a json field exactly once
      // (db/encode.ts), and it can only do that safely if every value reaching it has the same
      // shape as one carried forward from a select — which node-postgres has already parsed.
      // Stringifying here produced a second shape the writer could not tell apart, and a
      // carried-forward array was bound as a Postgres array literal and refused.
      if (typeof v === "object") return { ok: true, value: v };
      // The object case returned above, so what is left is a scalar the compiler only knows as
      // `unknown`. Stringified once so the reason is stated once.
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const text = String(v);
      try {
        return { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, reason: "invalid_json" };
      }
    }
    case "text":
    default:
      return typeof v === "string" || typeof v === "number"
        ? { ok: true, value: String(v) }
        : { ok: false, reason: "invalid_text" };
  }
}

/**
 * @param opts.taxonomies Bindings already resolved from the database by the caller. A
 * dataset-sourced vocabulary keeps its terms in env-scoped `app.terms`, which this function
 * cannot reach — it is synchronous and pure so that the unit tests need no database. Supply
 * the bindings and such a column is validated against `slugs` exactly like a YAML one; omit
 * them and it is refused as `unvalidatable_term`. The default stays closed.
 *
 * @param opts.mode Which import mode the payload is for. It changes only which columns the
 * payload must carry, never how a value is coerced:
 *
 *   - `append` creates a document, so every non-nullable column has to be there.
 *   - `upsert` addresses one, so the pk has to be there and nothing else does — a file that
 *     sets one column on 500 existing documents is the case this mode exists for. A row that
 *     turns out to be a create is re-checked for required columns by the caller, which is the
 *     only place that knows whether the document already existed.
 *   - `delete` names documents, so the pk is the only column it needs — and the only one it is
 *     allowed to be missing values for.
 */
export function validateImportRows(
  cfg: WarehousdConfig,
  collection: string,
  rows: Record<string, unknown>[],
  opts: {
    maxRows?: number | undefined;
    taxonomies?: TaxonomyBinding[] | undefined;
    mode?: "append" | "upsert" | "delete" | undefined;
  } = {},
): ImportValidation {
  const c = findCollection(cfg, collection);
  if (!c) return fileError("unknown_collection");
  // A chunked kind is ingested by the indexer, which owns chunking, checksums and deletion sync —
  // and one chunked blob carries one posture, so a salary column inside it could not be masked.
  // Per-column postures, filters and aggregates all need the dataset shape.
  if (kindOf(c).chunked) return fileError("file_collection");

  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  if (rows.length > maxRows) return fileError("too_many_rows");
  if (rows.length === 0) return fileError("no_rows");

  const errors: ImportError[] = [];
  // Two collections, on purpose. `errors` is the detail view and stays capped at MAX_ERRORS —
  // fifty error objects is all anyone reads, and building 10,000 of them costs memory for nothing.
  // `tally` is one entry per (scope, column, reason) and is never capped, so a report can say
  // "97 rows" without the cap being raised. See ImportErrorGroup.
  const tally = new Map<string, ImportErrorGroup>();
  const affectedRows = new Set<number>();
  const push = (e: ImportError) => {
    if (errors.length < MAX_ERRORS) errors.push(e);
    // A JSON tuple, not a delimiter-joined string: a header may contain whatever a
    // spreadsheet let somebody type, and two different (column, reason) pairs collapsing
    // into one group would silently under-report a column.
    const key = JSON.stringify([e.scope, e.column, e.reason]);
    const g = tally.get(key);
    if (g) {
      g.count += 1;
      if (e.scope === "row" && (g.firstRow === null || e.row < g.firstRow)) g.firstRow = e.row;
    } else {
      tally.set(key, {
        column: e.column,
        reason: e.reason,
        scope: e.scope,
        count: 1,
        firstRow: e.scope === "row" ? e.row : null,
      });
    }
    if (e.scope === "row") affectedRows.add(e.row);
  };
  // `headerCount` is filled in once the header row has been read; before that a refusal genuinely
  // does not know how many columns the file has.
  let headerCount: number | null = null;
  const refuse = (): ImportValidation => ({
    ok: false,
    errors,
    summary: finishSummary([...tally.values()], affectedRows.size, rows.length, headerCount),
  });

  // Storable columns: everything on the collection EXCEPT view_join and relation fields, neither
  // of which has a column on the base table — one is resolved from a sibling table at view time,
  // the other from the target's view at query time. Without this exclusion, a collection with a
  // relation field would refuse every otherwise-valid `append` import as `missing_required`, since
  // a relation can never appear in a payload for a header to satisfy.
  //
  // posture:deny columns ARE storable. Postures govern who may read a field, not whether it
  // exists — `people.home_address` is real data that must be importable and permanently
  // unreadable through the broker.
  const storable = new Map<string, FieldConfig>(
    Object.entries(c.fields).filter(([, f]) => !f.view_join && !f.relation),
  );
  const pk = Object.entries(c.fields).find(([, f]) => f.pk)?.[0] ?? null;
  // Build a map of taxonomy field names to their valid slugs.
  //
  // A YAML vocabulary carries its terms in the config. A dataset-sourced one keeps them in
  // env-scoped `app.terms`, which only the caller can read; it supplies them via
  // `opts.taxonomies`. Without them the column stays unvalidatable, and waving it through
  // would let an import write a term no grant can ever match — and worse, one no reviewer
  // would notice was unvalidated. Refuse instead; see `unvalidatable_term` below.
  const suppliedSlugs = new Map<string, string[]>(
    (opts.taxonomies ?? []).map((b) => [b.field, b.slugs]),
  );
  const termSlugsMap = new Map<string, Set<string>>();
  const datasetSourcedFields = new Set<string>();
  for (const vocabSlug of c.taxonomies ?? []) {
    const vocab = cfg.taxonomies?.[vocabSlug];
    if (vocab?.terms) termSlugsMap.set(vocabSlug, new Set(Object.keys(vocab.terms)));
    else if (vocab?.source) {
      const slugs = suppliedSlugs.get(vocabSlug);
      if (slugs) termSlugsMap.set(vocabSlug, new Set(slugs));
      else datasetSourcedFields.add(vocabSlug);
    }
  }

  const first = rows[0]!;
  // The payload's headers, and the field each one resolves to.
  //
  // `import.columns` is applied HERE, before the `c.fields[col]` lookup, which is the whole point
  // of it: `Base Salary (USD)` reaches `base_salary` instead of reporting `unknown_column`. A
  // header with no mapping still resolves to itself, so a file whose headers already match the
  // field names needs no config at all. Errors keep naming the HEADER, because that is what the
  // person holding the spreadsheet can find.
  const mapping = c.import?.columns ?? {};
  const headers = Object.keys(first);
  headerCount = headers.length;
  const resolved = headers.map((header) => ({ header, field: mapping[header] ?? header }));
  const seenField = new Map<string, string>();
  for (const { header, field } of resolved) {
    const f = c.fields[field];
    if (!f) {
      push({ row: 0, column: header, reason: "unknown_column", scope: "column" });
      continue;
    }
    // Two headers landing on one field. Config catches a mapping that does it twice
    // (import/column-target-unique); this catches the file that supplies both the mapped header
    // and the field's own name, which no config rule can see.
    const clash = seenField.get(field);
    if (clash !== undefined && clash !== header)
      push({ row: 0, column: header, reason: "duplicate_column", scope: "column" });
    else seenField.set(field, header);
    if (f.view_join || f.relation)
      push({ row: 0, column: header, reason: "derived_column", scope: "column" });
    if (datasetSourcedFields.has(field))
      push({ row: 0, column: header, reason: "unvalidatable_term", scope: "column" });
  }
  if (errors.length) return refuse();

  // Downstream — run.ts, insertRevision, the change feed — every one of these is a real column
  // name, so the payload's headers stop existing at this line.
  const columns = resolved.map((r) => r.field);

  const mode = opts.mode ?? "append";
  if (mode === "append") {
    // Creating a document: every non-nullable storable column must be in the payload's columns.
    for (const [name, f] of storable) {
      if (columns.includes(name)) continue;
      if (f.nullable) continue;
      push({ row: 0, column: name, reason: "missing_required", scope: "column" });
    }
  } else {
    // Addressing existing documents: the pk is what does the addressing, so it is the one
    // column that must be there. A collection with no pk cannot be upserted or deleted into at
    // all, which run.ts refuses before it gets here — this is the belt to that's braces.
    if (!pk) push({ row: 0, column: null, reason: "no_primary_key", scope: "column" });
    else if (!columns.includes(pk))
      push({ row: 0, column: pk, reason: "missing_required", scope: "column" });
  }
  if (errors.length) return refuse();

  const seenPk = new Set<string>();
  const values: unknown[][] = [];
  // Errors name the HEADER throughout the per-cell pass, so a report points at a column the
  // person holding the spreadsheet can actually find. Without a mapping the two are the same
  // string, which is why nothing changed for a file whose headers already match the fields.
  const pkHeader = pk === null ? null : (resolved.find((r) => r.field === pk)?.header ?? pk);

  rows.forEach((r, idx) => {
    const keys = Object.keys(r);
    // Compared against the HEADERS: the row still carries the names the file used, and the
    // mapping is a lens over them rather than a rewrite of the payload.
    if (keys.length !== headers.length || !headers.every((k) => k in r)) {
      push({ row: idx, column: null, reason: "ragged_rows", scope: "row" });
      return;
    }
    const out: unknown[] = [];
    for (const { header, field: col } of resolved) {
      const f = storable.get(col)!;
      const raw = r[header];
      const empty =
        raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
      if (empty) {
        // An empty cell in a column the config says must carry a value is a refusal — on the
        // modes that write that value. A delete uses the pk and ignores every other column, so
        // holding its file to the full shape would refuse files that are perfectly valid.
        const enforced = mode === "delete" ? col === pk : !f.nullable;
        if (enforced) {
          push({ row: idx, column: header, reason: "missing_required", scope: "row" });
          out.push(null);
          continue;
        }
        out.push(null);
        continue;
      }
      // Check if this column is a vocabulary field
      const vocabTerms = termSlugsMap.get(col);
      if (vocabTerms) {
        // A CSV cell; `unknown` to the compiler because the parser hands back untyped values. A
        // non-scalar would stringify to "[object Object]", which then matches no term slug and is
        // reported as `unknown_term` — the right answer, arrived at without a special case.
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const cell = String(raw);
        // A multi-value column arrives semicolon-separated (a comma would collide with the
        // CSV delimiter); every part is validated against the term set independently.
        if (cfg.taxonomies[col]?.multiple) {
          const parts = cell
            .split(";")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          if (!parts.length || parts.some((t) => !vocabTerms.has(t))) {
            push({ row: idx, column: header, reason: "unknown_term", scope: "row" });
            out.push(null);
            continue;
          }
          out.push(parts);
          continue;
        }
        if (!vocabTerms.has(cell)) {
          push({ row: idx, column: header, reason: "unknown_term", scope: "row" });
          out.push(null);
          continue;
        }
        out.push(cell);
        continue;
      }
      const co = coerce(raw, f);
      if (!co.ok) {
        push({ row: idx, column: header, reason: co.reason, scope: "row" });
        out.push(null);
        continue;
      }
      out.push(co.value);
    }
    if (pk && columns.includes(pk)) {
      const pkValue = out[columns.indexOf(pk)];
      if (pkValue !== null) {
        // Same reasoning as `cell` above: a pk is a scalar, but only `unknown` to the compiler.
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const key = String(pkValue);
        if (seenPk.has(key))
          push({ row: idx, column: pkHeader, reason: "duplicate_pk", scope: "row" });
        seenPk.add(key);
      }
    }
    values.push(out);
  });

  if (errors.length) return refuse();
  return { ok: true, columns, values };
}
