import type { QueryIntent, FilterOp, DocumentFilter, Aggregate } from "../types";
import { MAX_LIMIT, DEFAULT_LIMIT } from "../types";

// A filter the builder can express no SQL for. Distinct from the generic Error below so the
// broker can answer `invalid_intent` — a caller's mistake — rather than `internal_error`.
export class UnsupportedFilter extends Error {}

const OP_SQL: Record<Exclude<FilterOp, "in">, string> = {
  eq: "=", neq: "<>", gt: ">", lt: "<", gte: ">=", lte: "<=", like: "like",
};
// An aggregate's `fn` is the only part of an intent that lands in the SQL text as syntax rather
// than as a bound parameter, so it gets the same treatment as an identifier: looked up in a
// closed set, never interpolated from the caller's string. The intent schema holds it to this
// same enum; this is the layer that must not depend on that having happened.
const AGG_SQL: Record<Aggregate["fn"], string> = {
  avg: "avg", sum: "sum", count: "count", min: "min", max: "max",
};
// `OP_SQL[op]` and `AGG_SQL[fn]` are property reads on object literals, so every name on
// Object.prototype answers them: `op: "constructor"` returns the Object constructor, whose
// string form then lands in the statement. Own properties only, and an unknown name is the
// caller's mistake — invalid_intent — rather than a broken statement.
function lookup(table: object, key: unknown, kind: string): string {
  if (typeof key !== "string" || !Object.hasOwn(table, key))
    throw new UnsupportedFilter(`unknown ${kind}: ${String(key)}`);
  return (table as Record<string, string>)[key]!;
}
// Identifiers reaching q() are drawn from the collection's YAML-defined field set:
// granted fields for client intents, plus the grant-author-supplied document_filter.field
// (validated against the same YAML set in broker.ts) — never from raw client input.
// Field names are validated at config load time, so invalid identifiers here indicate a broker bug.
// If a bad identifier somehow reaches q(), it throws synchronously and is caught by try/catch
// in broker.ts's query/searchDocuments, which wraps execution in audit logging and returns internal_error.
const IDENT = /^[a-z_][a-z0-9_]*$/i;
const q = (id: string) => {
  if (!IDENT.test(id)) throw new Error(`unsafe identifier: ${id}`);
  return `"${id}"`;
};

export function buildSelect(
  env: "dev" | "live", intent: QueryIntent, grantedFields: string[],
  // searchFields: the dataset fields carrying a generated "<f>_tsv" column. Omitted means a
  // file collection, whose view exposes a single fixed `tsv`. Field names go through q() like
  // every other identifier — they are config-validated, but that is the builder's rule to keep.
  opts: { documentFilters?: DocumentFilter[]; q?: string;
          isMultiValueField?: (field: string) => boolean; searchFields?: string[] } = {},
): { text: string; values: unknown[] } {
  const schema = env === "dev" ? "data_synth" : "data_live";
  const view = `${schema}.v_${intent.collection}`;
  const values: unknown[] = [];
  const param = (v: unknown) => { values.push(v); return `$${values.length}`; };

  let selectClause: string;
  if (intent.aggregate && intent.aggregate.length) {
    const groupCols = (intent.groupBy ?? []).map(q);
    const aggs = intent.aggregate.map((a) => {
      const fn = lookup(AGG_SQL, a.fn, "aggregate function");
      // The alias is built from the looked-up name and the quoted field, never from the raw
      // strings: `as "<caller text>"` is an injection point of its own the moment the caller's
      // text can contain a double quote.
      return `${fn}(${q(a.field)}) as ${q(`${fn}_${a.field}`)}`;
    });
    selectClause = [...groupCols, ...aggs].join(", ");
  } else {
    const cols = (intent.fields && intent.fields.length ? intent.fields : grantedFields).map(q);
    selectClause = cols.join(", ");
  }

  // A file collection searches its one `tsv` column; a dataset searches the concatenation of
  // its searchable fields' generated columns, so one query matches across all of them.
  const isFileSearch = !opts.searchFields?.length;
  const tsvExpr = isFileSearch ? "tsv" : opts.searchFields!.map((f) => q(`${f}_tsv`)).join(" || ");

  let rankExpr: string | null = null;
  let searchSlot: string | null = null;
  if (opts.q !== undefined) {
    searchSlot = param(opts.q); // ONE slot, reused for WHERE and ORDER BY
    const tsq = `websearch_to_tsquery('english', ${searchSlot})`;
    rankExpr = `ts_rank_cd(${tsvExpr}, ${tsq})`;
    selectClause += `, ${rankExpr} as "_rank"`;
    // document_seq is a file-collection column: one file yields many documents, and the seq
    // identifies which. A dataset document is the whole row, so there is nothing to number.
    if (isFileSearch) selectClause += `, "document_seq"`;
  }

  let text = `select ${selectClause} from ${view}`;

  const where: string[] = [];
  for (const f of intent.filters ?? []) {
    const isMulti = opts.isMultiValueField?.(f.field) ?? false;
    if (f.op === "in") {
      const arr = Array.isArray(f.value) ? f.value : [f.value];
      // An empty in-list matches nothing. Say so outright — the same guard the grant's
      // document filters below have always had; intent filters were missing it.
      if (!arr.length) { where.push("false"); continue; }
      if (isMulti) {
        // For multi-value columns, use overlap operator: "col" && $n::text[]
        const arrParam = param(arr);
        where.push(`${q(f.field)} && ${arrParam}::text[]`);
      } else {
        where.push(`${q(f.field)} in (${arr.map(param).join(", ")})`);
      }
    } else if (isMulti && f.op === "eq") {
      // For multi-value columns with eq, use: $n = any("col")
      where.push(`${param(f.value)} = any(${q(f.field)})`);
    } else if (isMulti) {
      // Ordering and pattern operators have no defensible meaning against a set of terms, and
      // the scalar form below would compare text[] against text — a driver error the caller
      // can do nothing with. Refuse the intent instead; broker.ts maps this to invalid_intent.
      throw new UnsupportedFilter(`operator "${f.op}" is not supported on multi-value field "${f.field}"`);
    } else {
      where.push(`${q(f.field)} ${lookup(OP_SQL, f.op, "operator")} ${param(f.value)}`);
    }
  }
  // AND all grant-carried document filters.
  //
  // This is one of two evaluators for the same rule: the write path cannot reuse this SQL (it
  // reads base tables for the `_rev*` columns, which the view does not expose) and re-evaluates
  // the filters in process in grants/filters.ts. The two must agree about every grant, so a
  // change to the semantics here belongs there as well, and test/filter-parity.test.ts asserts
  // their agreement against a live Postgres. Filters that could not be made to agree are
  // rejected before either evaluator sees them, by validateDocumentFilters.
  for (const rf of opts.documentFilters ?? []) {
    const isMulti = opts.isMultiValueField?.(rf.field) ?? false;
    if (rf.op === "in") {
      const arr = Array.isArray(rf.value) ? rf.value : [rf.value];
      if (isMulti) {
        // For multi-value columns, use overlap operator: "col" && $n::text[]
        const arrParam = param(arr);
        where.push(arr.length ? `${q(rf.field)} && ${arrParam}::text[]` : `false`);
      } else {
        where.push(arr.length ? `${q(rf.field)} in (${arr.map(param).join(", ")})` : `false`);
      }
    } else if (isMulti) {
      // For multi-value columns with eq, use: $n = any("col")
      where.push(`${param(rf.value)} = any(${q(rf.field)})`);
    } else {
      where.push(`${q(rf.field)} = ${param(rf.value)}`);
    }
  }

  // Add full-text search WHERE clause if q is present (reuses searchSlot)
  if (searchSlot !== null)
    where.push(`${tsvExpr} @@ websearch_to_tsquery('english', ${searchSlot})`);

  if (where.length) text += ` where ${where.join(" and ")}`;

  if (intent.groupBy && intent.groupBy.length)
    text += ` group by ${intent.groupBy.map(q).join(", ")}`;

  // ORDER BY: when rankExpr present, relevance overrides intent.orderBy
  if (rankExpr) text += ` order by ${rankExpr} desc`;
  else if (intent.orderBy) text += ` order by ${q(intent.orderBy.field)} ${intent.orderBy.dir === "desc" ? "desc" : "asc"}`;

  const limit = Math.min(Math.max(1, intent.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  text += ` limit ${limit}`;
  if (intent.offset && intent.offset > 0) text += ` offset ${Math.floor(intent.offset)}`;

  return { text, values };
}
