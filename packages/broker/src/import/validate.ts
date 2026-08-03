import type { WarehousdConfig, FieldConfig } from "../config/schema";
import { findCollection } from "../config/load";
import type { TaxonomyBinding } from "../taxonomy";

export type ImportError = { row: number; column: string | null; reason: string };

export type ImportPlan = { columns: string[]; values: unknown[][] };
export type ImportValidation =
  { ok: true; columns: string[]; values: unknown[][] } | { ok: false; errors: ImportError[] };

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
  switch (f.type) {
    case "uuid":
      return typeof v === "string" && UUID_RE.test(v)
        ? { ok: true, value: v }
        : { ok: false, reason: "invalid_uuid" };
    case "int": {
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (!Number.isInteger(n)) return { ok: false, reason: "invalid_int" };
      return { ok: true, value: n };
    }
    case "numeric": {
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (!Number.isFinite(n)) return { ok: false, reason: "invalid_numeric" };
      return { ok: true, value: n };
    }
    case "boolean": {
      if (typeof v === "boolean") return { ok: true, value: v };
      const s = String(v).trim().toLowerCase();
      if (["true", "t", "1", "yes"].includes(s)) return { ok: true, value: true };
      if (["false", "f", "0", "no"].includes(s)) return { ok: true, value: false };
      return { ok: false, reason: "invalid_boolean" };
    }
    case "date":
    case "timestamptz": {
      const t = Date.parse(String(v));
      if (Number.isNaN(t)) return { ok: false, reason: "invalid_date" };
      return { ok: true, value: new Date(t).toISOString() };
    }
    case "json": {
      if (typeof v === "object") return { ok: true, value: JSON.stringify(v) };
      // The object case returned on the line above, so what is left is a scalar — which the
      // compiler still only knows as `unknown`. Stringified once so the reason is stated once.
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const text = String(v);
      try {
        JSON.parse(text);
        return { ok: true, value: text };
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
  if (!c) return { ok: false, errors: [{ row: -1, column: null, reason: "unknown_collection" }] };
  // Files are ingested by the indexer, which owns chunking, checksums and deletion sync.
  if (c.type === "file")
    return { ok: false, errors: [{ row: -1, column: null, reason: "file_collection" }] };

  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  if (rows.length > maxRows)
    return { ok: false, errors: [{ row: -1, column: null, reason: "too_many_rows" }] };
  if (rows.length === 0)
    return { ok: false, errors: [{ row: -1, column: null, reason: "no_rows" }] };

  const errors: ImportError[] = [];
  const push = (e: ImportError) => {
    if (errors.length < MAX_ERRORS) errors.push(e);
  };

  // Storable columns: everything on the collection EXCEPT view_join fields, which are
  // resolved from a sibling table at view time and have no column on the base table.
  //
  // posture:deny columns ARE storable. Postures govern who may read a field, not whether it
  // exists — `people.home_address` is real data that must be importable and permanently
  // unreadable through the broker.
  const storable = new Map<string, FieldConfig>(
    Object.entries(c.fields).filter(([, f]) => !f.view_join),
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
  const columns = Object.keys(first);
  for (const col of columns) {
    const f = c.fields[col];
    if (!f) {
      push({ row: 0, column: col, reason: "unknown_column" });
      continue;
    }
    if (f.view_join) push({ row: 0, column: col, reason: "derived_column" });
    if (datasetSourcedFields.has(col)) push({ row: 0, column: col, reason: "unvalidatable_term" });
  }
  if (errors.length) return { ok: false, errors };

  const mode = opts.mode ?? "append";
  if (mode === "append") {
    // Creating a document: every non-nullable storable column must be in the payload's columns.
    for (const [name, f] of storable) {
      if (columns.includes(name)) continue;
      if (f.nullable) continue;
      push({ row: 0, column: name, reason: "missing_required" });
    }
  } else {
    // Addressing existing documents: the pk is what does the addressing, so it is the one
    // column that must be there. A collection with no pk cannot be upserted or deleted into at
    // all, which run.ts refuses before it gets here — this is the belt to that's braces.
    if (!pk) push({ row: 0, column: null, reason: "no_primary_key" });
    else if (!columns.includes(pk)) push({ row: 0, column: pk, reason: "missing_required" });
  }
  if (errors.length) return { ok: false, errors };

  const seenPk = new Set<string>();
  const values: unknown[][] = [];

  rows.forEach((r, idx) => {
    const keys = Object.keys(r);
    if (keys.length !== columns.length || !columns.every((k) => k in r)) {
      push({ row: idx, column: null, reason: "ragged_rows" });
      return;
    }
    const out: unknown[] = [];
    for (const col of columns) {
      const f = storable.get(col)!;
      const raw = r[col];
      const empty =
        raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
      if (empty) {
        // An empty cell in a column the config says must carry a value is a refusal — on the
        // modes that write that value. A delete uses the pk and ignores every other column, so
        // holding its file to the full shape would refuse files that are perfectly valid.
        const enforced = mode === "delete" ? col === pk : !f.nullable;
        if (enforced) {
          push({ row: idx, column: col, reason: "missing_required" });
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
            push({ row: idx, column: col, reason: "unknown_term" });
            out.push(null);
            continue;
          }
          out.push(parts);
          continue;
        }
        if (!vocabTerms.has(cell)) {
          push({ row: idx, column: col, reason: "unknown_term" });
          out.push(null);
          continue;
        }
        out.push(cell);
        continue;
      }
      const co = coerce(raw, f);
      if (!co.ok) {
        push({ row: idx, column: col, reason: co.reason });
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
        if (seenPk.has(key)) push({ row: idx, column: pk, reason: "duplicate_pk" });
        seenPk.add(key);
      }
    }
    values.push(out);
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, columns, values };
}
