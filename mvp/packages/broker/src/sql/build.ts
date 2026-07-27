import type { QueryIntent, FilterOp, DocumentFilter } from "../types";
import { MAX_LIMIT, DEFAULT_LIMIT } from "../types";

const OP_SQL: Record<Exclude<FilterOp, "in">, string> = {
  eq: "=", neq: "<>", gt: ">", lt: "<", gte: ">=", lte: "<=", like: "like",
};
// Identifiers reaching q() are drawn from the collection's YAML-defined field set:
// granted fields for client intents, plus the grant-author-supplied document_filter.field
// (validated against the same YAML set in broker.ts) — never from raw client input.
// Field names are validated at config load time, so invalid identifiers here indicate a broker bug.
// If a bad identifier somehow reaches q(), it throws synchronously and is caught by try/catch
// in broker.queryOrMutate, which wraps execution in audit logging and returns internal_error.
const IDENT = /^[a-z_][a-z0-9_]*$/i;
const q = (id: string) => {
  if (!IDENT.test(id)) throw new Error(`unsafe identifier: ${id}`);
  return `"${id}"`;
};

export function buildSelect(
  env: "dev" | "live", intent: QueryIntent, grantedFields: string[],
  opts: { documentFilter?: DocumentFilter | null; q?: string } = {},
): { text: string; values: unknown[] } {
  const schema = env === "dev" ? "data_synth" : "data_live";
  const view = `${schema}.v_${intent.collection}`;
  const values: unknown[] = [];
  const param = (v: unknown) => { values.push(v); return `$${values.length}`; };

  let selectClause: string;
  if (intent.aggregate && intent.aggregate.length) {
    const groupCols = (intent.groupBy ?? []).map(q);
    const aggs = intent.aggregate.map((a) => `${a.fn}(${q(a.field)}) as "${a.fn}_${a.field}"`);
    selectClause = [...groupCols, ...aggs].join(", ");
  } else {
    const cols = (intent.fields && intent.fields.length ? intent.fields : grantedFields).map(q);
    selectClause = cols.join(", ");
  }

  let rankExpr: string | null = null;
  let searchSlot: string | null = null;
  if (opts.q !== undefined) {
    searchSlot = param(opts.q); // ONE slot, reused for WHERE and ORDER BY
    const tsq = `websearch_to_tsquery('english', ${searchSlot})`;
    rankExpr = `ts_rank_cd(tsv, ${tsq})`;
    selectClause += `, ${rankExpr} as "_rank", "document_seq"`;
  }

  let text = `select ${selectClause} from ${view}`;

  const where: string[] = [];
  for (const f of intent.filters ?? []) {
    if (f.op === "in") {
      const arr = Array.isArray(f.value) ? f.value : [f.value];
      where.push(`${q(f.field)} in (${arr.map(param).join(", ")})`);
    } else {
      where.push(`${q(f.field)} ${OP_SQL[f.op]} ${param(f.value)}`);
    }
  }
  // AND the grant-carried document filter
  const rf = opts.documentFilter;
  if (rf) {
    if (rf.op === "in") {
      const arr = Array.isArray(rf.value) ? rf.value : [rf.value];
      where.push(arr.length ? `${q(rf.field)} in (${arr.map(param).join(", ")})` : `false`);
    } else {
      where.push(`${q(rf.field)} = ${param(rf.value)}`);
    }
  }

  // Add full-text search WHERE clause if q is present (reuses searchSlot)
  if (searchSlot !== null) {
    const tsq = `websearch_to_tsquery('english', ${searchSlot})`;
    where.push(`tsv @@ ${tsq}`);
  }

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
