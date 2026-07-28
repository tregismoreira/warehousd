import type { WarehousdConfig, FieldConfig } from "../config/schema";
import { findCollection } from "../config/load";

export type ImportError = { row: number; column: string | null; reason: string };

export type ImportPlan = { columns: string[]; values: unknown[][] };
export type ImportValidation =
  | { ok: true; columns: string[]; values: unknown[][] }
  | { ok: false; errors: ImportError[] };

const MAX_ERRORS = 50;
const DEFAULT_MAX_ROWS = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Coerce one cell to its declared type, or return a reason code. CSV delivers everything as
// a string, so the numeric/boolean/date branches must accept string input.
//
// Errors carry a reason code and never the value: an import file may hold real personal
// data, and an error body is still a response body (invariant 4's discipline).
function coerce(v: unknown, f: FieldConfig): { ok: true; value: unknown } | { ok: false; reason: string } {
  switch (f.type) {
    case "uuid":
      return typeof v === "string" && UUID_RE.test(v)
        ? { ok: true, value: v } : { ok: false, reason: "invalid_uuid" };
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
    case "json":
      if (typeof v === "object") return { ok: true, value: JSON.stringify(v) };
      try { JSON.parse(String(v)); return { ok: true, value: String(v) }; }
      catch { return { ok: false, reason: "invalid_json" }; }
    case "text":
    default:
      return typeof v === "string" || typeof v === "number"
        ? { ok: true, value: String(v) } : { ok: false, reason: "invalid_text" };
  }
}

export function validateImportRows(
  cfg: WarehousdConfig,
  collection: string,
  rows: Record<string, unknown>[],
  opts: { maxRows?: number } = {},
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
  const push = (e: ImportError) => { if (errors.length < MAX_ERRORS) errors.push(e); };

  // Storable columns: everything on the collection EXCEPT view_join fields, which are
  // resolved from a sibling table at view time and have no column on the base table.
  //
  // posture:deny columns ARE storable. Postures govern who may read a field, not whether it
  // exists — `people.home_address` is real data that must be importable and permanently
  // unreadable through the broker.
  const storable = new Map<string, FieldConfig>(
    Object.entries(c.fields).filter(([, f]) => !f.view_join));
  const pk = Object.entries(c.fields).find(([, f]) => f.pk)?.[0] ?? null;
  // Build a map of taxonomy field names to their valid slugs
  const termSlugsMap = new Map<string, Set<string>>();
  for (const vocabSlug of c.taxonomies ?? []) {
    const vocab = cfg.taxonomies[vocabSlug];
    if (vocab?.terms) {
      termSlugsMap.set(vocabSlug, new Set(Object.keys(vocab.terms)));
    }
  }

  const first = rows[0]!;
  const columns = Object.keys(first);
  for (const col of columns) {
    const f = c.fields[col];
    if (!f) { push({ row: 0, column: col, reason: "unknown_column" }); continue; }
    if (f.view_join) push({ row: 0, column: col, reason: "derived_column" });
  }
  if (errors.length) return { ok: false, errors };

  // Every non-nullable storable column must be present in the payload's column set.
  for (const [name, f] of storable) {
    if (columns.includes(name)) continue;
    if (f.nullable) continue;
    push({ row: 0, column: name, reason: "missing_required" });
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
      const empty = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
      if (empty) {
        if (!f.nullable) { push({ row: idx, column: col, reason: "missing_required" }); out.push(null); continue; }
        out.push(null);
        continue;
      }
      // Check if this column is a vocabulary field
      const vocabTerms = termSlugsMap.get(col);
      if (vocabTerms) {
        // For single-value vocabularies, validate that the value is a valid term
        // (multi-value columns would need semicolon-separated parsing, handled elsewhere)
        const vocab = cfg.taxonomies[col];
        if (!vocab?.multiple && !vocabTerms.has(String(raw))) {
          push({ row: idx, column: col, reason: "unknown_term" });
          out.push(null);
          continue;
        }
        out.push(String(raw));
        continue;
      }
      const co = coerce(raw, f);
      if (!co.ok) { push({ row: idx, column: col, reason: co.reason }); out.push(null); continue; }
      out.push(co.value);
    }
    if (pk && columns.includes(pk)) {
      const pkValue = out[columns.indexOf(pk)];
      if (pkValue !== null) {
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
