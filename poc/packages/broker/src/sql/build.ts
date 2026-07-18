import type { QueryIntent, FilterOp } from "../types";
import { MAX_LIMIT, DEFAULT_LIMIT } from "../types";

const OP_SQL: Record<Exclude<FilterOp, "in">, string> = {
  eq: "=", neq: "<>", gt: ">", lt: "<", gte: ">=", lte: "<=", like: "like",
};
const q = (id: string) => `"${id}"`; // caller guarantees id ∈ grantedFields (safe to quote)

export function buildSelect(
  env: "dev" | "live", intent: QueryIntent, grantedFields: string[],
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
  if (where.length) text += ` where ${where.join(" and ")}`;

  if (intent.groupBy && intent.groupBy.length)
    text += ` group by ${intent.groupBy.map(q).join(", ")}`;

  if (intent.orderBy) text += ` order by ${q(intent.orderBy.field)} ${intent.orderBy.dir === "desc" ? "desc" : "asc"}`;

  const limit = Math.min(Math.max(1, intent.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  text += ` limit ${limit}`;
  if (intent.offset && intent.offset > 0) text += ` offset ${Math.floor(intent.offset)}`;

  return { text, values };
}
