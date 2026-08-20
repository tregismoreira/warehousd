import type { QueryIntent, FilterOp, DocumentFilter, Aggregate } from "../types";
import { MAX_LIMIT, DEFAULT_LIMIT } from "../types";
import { ident } from "./ident";
import { maskExpr } from "./mask";
import type { MaskConfig } from "../config/schema";
import { dataSchema } from "../config/collection";
import { aclPredicate } from "../acl/sql";
import type { RelationDef } from "../config/schema";
import { readPosture } from "../config/schema";

// A filter the builder can express no SQL for. Distinct from the generic Error below so the
// broker can answer `invalid_intent` — a caller's mistake — rather than `internal_error`.
export class UnsupportedFilter extends Error {}

const OP_SQL: Record<Exclude<FilterOp, "in">, string> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
  like: "like",
};
// An aggregate's `fn` is the only part of an intent that lands in the SQL text as syntax rather
// than as a bound parameter, so it gets the same treatment as an identifier: looked up in a
// closed set, never interpolated from the caller's string. The intent schema holds it to this
// same enum; this is the layer that must not depend on that having happened.
const AGG_SQL: Record<Aggregate["fn"], string> = {
  avg: "avg",
  sum: "sum",
  count: "count",
  min: "min",
  max: "max",
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
// (validated against the same YAML set in verbs/read.ts) — never from raw client input.
// Field names are validated at config load time, so invalid identifiers here indicate a broker bug.
// If a bad identifier somehow reaches q(), it throws synchronously and is caught by try/catch
// in the read verbs, which wrap execution in audit logging and return internal_error.
const q = ident;

export function buildSelect(
  env: "dev" | "live",
  intent: QueryIntent,
  grantedFields: string[],
  // searchFields: the dataset fields carrying a generated "<f>_tsv" column. Omitted means a
  // file collection, whose view exposes a single fixed `tsv`. Field names go through q() like
  // every other identifier — they are config-validated, but that is the builder's rule to keep.
  // maskFor: the transform to apply to a field, or null to select it raw. Supplied by the read
  // verbs, which are the only place that knows both the posture and whether this caller's grant
  // carries an unmask for it. Returning null for everything is the unmasked behaviour.
  opts: {
    documentFilters?: DocumentFilter[];
    q?: string;
    isMultiValueField?: (field: string) => boolean;
    searchFields?: string[];
    maskFor?: (field: string) => MaskConfig | null;
    // The query vector, already derived server-side from `q` by the read verb. Present only for
    // `semantic` and `hybrid`. There is no path from a client-supplied vector to here.
    qVector?: number[];
    mode?: "text" | "semantic" | "hybrid";
    // The caller's principal set, supplied ONLY for a collection whose view carries an `_acl`
    // column (`acl: true`). Present means the per-document predicate is ANDed in; absent means the
    // collection has no ACLs and the column does not exist to be compared. Never a value from a
    // request — the read verbs take it from the loaded grant, which derives it from
    // `app.user_groups` (acl/principals.ts).
    aclPrincipals?: string[];
    // Keyset pagination. `field` and `pk` are config-validated identifiers (verbs/read.ts resolves
    // and grant-checks them before this is called), never raw client input, so they go through
    // q() like every other identifier. `after`, when present, is the caller's cursor position —
    // both values are always bound parameters (invariant 2). Mutually exclusive with `rankExpr`
    // (search ranking), `offset` and `aggregate`; the verb refuses that combination before
    // reaching here, but this function must not emit two ORDER BYs if it is ever called wrong.
    keyset?: { field: string; dir: "asc" | "desc"; pk: string; after?: [unknown, unknown] };
    // How to expand a relation field, or null if the field is not a relation. Supplied by the
    // read verbs from the collection config, never from a request.
    relationFor?: (field: string) => RelationDef | null;
    // Whether the TARGET collection carries per-document ACLs, so the subquery knows whether the
    // target's view has an `_acl` column to compare.
    targetHasAcl?: (collection: string) => boolean;
    // The `fk` string of a local field, for resolving which TARGET column a relation joins to.
    fkOf?: (field: string) => string | null;
    // The caller's principal set, for a relation's TARGET — deliberately separate from
    // `aclPrincipals` above, which is gated on the HOST collection's own `acl: true` and must stay
    // genuinely absent when the host has no `_acl` column for the top-level predicate to compare
    // against. A relation's target can carry `acl: true` while the host does not, so the read
    // verbs supply this whenever a grant is loaded, independent of the host's own ACL state.
    relationPrincipals?: string[];
  } = {},
): { text: string; values: unknown[] } {
  const schema = dataSchema(env);
  const view = `${schema}.v_${intent.collection}`;
  const values: unknown[] = [];
  const param = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };

  let selectClause: string;
  if (intent.aggregate && intent.aggregate.length) {
    // No masking branch here on purpose. An aggregate over a masked field is refused before this
    // function is called (verbs/read.ts) — avg() of a bucketed column is not a masked average,
    // it is a different number presented as one, and min()/max() would leak the raw extremes.
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
    // The one place a column becomes a select-list entry, and therefore the one place masking
    // has to be applied for it to be applied at all.
    const cols = (intent.fields && intent.fields.length ? intent.fields : grantedFields).map(
      (f) => {
        const rel = opts.relationFor?.(f) ?? null;
        if (rel) {
          // `fk: clients.id` → join against `clients.id`. The config rule has already checked
          // that the fk names this relation's collection, so the split is safe.
          const fk = opts.fkOf?.(rel.on) ?? null;
          const targetColumn = fk ? (fk.split(".")[1] ?? "id") : "id";
          return relationExpr(env, f, rel, targetColumn, param, opts);
        }
        const mask = opts.maskFor?.(f) ?? null;
        return mask ? maskExpr(f, mask, param) : q(f);
      },
    );
    selectClause = cols.join(", ");
  }

  // A file collection searches its one `tsv` column; a dataset searches the concatenation of
  // its searchable fields' generated columns, so one query matches across all of them.
  const isFileSearch = !opts.searchFields?.length;
  const tsvExpr = isFileSearch ? "tsv" : opts.searchFields!.map((f) => q(`${f}_tsv`)).join(" || ");

  const mode = opts.mode ?? "text";
  // The projection alone, before any ranking column is appended. Hybrid needs it separately
  // because it wraps the whole thing in CTEs.
  const projection = selectClause;
  let rankExpr: string | null = null;
  let searchSlot: string | null = null;
  let vectorSlot: string | null = null;
  let tsq: string | null = null;
  if (opts.q !== undefined) {
    // Only bind the query text when the statement will actually reference it. A pure semantic
    // search ranks by vector alone and matches no tsquery, so binding it there left a parameter
    // present in the values array and absent from the text — which Postgres reports as "could
    // not determine data type of parameter $1", several layers away from the cause.
    if (mode !== "semantic") {
      searchSlot = param(opts.q); // ONE slot, reused for WHERE and ORDER BY
      tsq = `websearch_to_tsquery('english', ${searchSlot})`;
    }
    if (opts.qVector) vectorSlot = param(`[${opts.qVector.join(",")}]`);
    // Cosine distance turned into a similarity, so bigger is better exactly as ts_rank_cd is.
    // `<=>` is the operator the HNSW index in tableDDL is built for.
    const vecRank = vectorSlot ? `1 - (embedding <=> ${vectorSlot}::vector)` : null;
    rankExpr =
      mode === "semantic" && vecRank ? vecRank : tsq ? `ts_rank_cd(${tsvExpr}, ${tsq})` : null;
    if (mode !== "hybrid") {
      selectClause += `, ${rankExpr} as "_rank"`;
      // document_seq is a file-collection column: one file yields many documents, and the seq
      // identifies which. A dataset document is the whole row, so there is nothing to number.
      if (isFileSearch) selectClause += `, "document_seq"`;
    }
  }

  let text = `select ${selectClause} from ${view} base`;

  const where: string[] = [];
  for (const f of intent.filters ?? []) {
    const isMulti = opts.isMultiValueField?.(f.field) ?? false;
    if (f.op === "in") {
      const arr = Array.isArray(f.value) ? f.value : [f.value];
      // An empty in-list matches nothing. Say so outright — the same guard the grant's
      // document filters below have always had; intent filters were missing it.
      if (!arr.length) {
        where.push("false");
        continue;
      }
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
      // can do nothing with. Refuse the intent instead; verbs/read.ts maps this to invalid_intent.
      throw new UnsupportedFilter(
        `operator "${f.op}" is not supported on multi-value field "${f.field}"`,
      );
    } else {
      where.push(`${q(f.field)} ${lookup(OP_SQL, f.op, "operator")} ${param(f.value)}`);
    }
  }
  // Keyset pagination's WHERE half: a row-value comparison against the caller's cursor position,
  // both values bound parameters. Postgres can use a composite index — (sortField, pk) — to serve
  // this form without a sort over the whole result. Absent `after` means "first page": total order
  // still needs the ORDER BY below, but there is no lower bound to add yet.
  if (opts.keyset?.after) {
    const { field, pk, dir, after } = opts.keyset;
    const op = dir === "asc" ? ">" : "<";
    where.push(`(${q(field)}, ${q(pk)}) ${op} (${param(after[0])}, ${param(after[1])})`);
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

  // The per-document ACL, ANDed in with everything else.
  //
  // It goes in `where` rather than anywhere later on purpose: `whereClause` below is what both
  // hybrid CTEs interpolate, so putting it here is what lands it inside `scoped` — the ACL is
  // applied BEFORE either ranking and before either LIMIT. Ranked-then-filtered would leak the
  // same way a grant filter would: a caller asking for 5 would get however many of the global
  // top-5 they may see, and the shortfall itself reports how many they may not.
  //
  // A fixed clause, never composed from caller input. The principal set is the only thing that
  // varies and it is a bound parameter, like every other value (invariant 2).
  if (opts.aclPrincipals) where.push(aclPredicate(param(opts.aclPrincipals)));

  // The lexical match. NOT applied in semantic mode: the whole point of a vector search is to
  // find documents that do not contain the query's words.
  if (searchSlot !== null && mode !== "semantic" && mode !== "hybrid")
    where.push(`${tsvExpr} @@ websearch_to_tsquery('english', ${searchSlot})`);

  const limit = Math.min(Math.max(1, intent.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const offset = intent.offset && intent.offset > 0 ? ` offset ${Math.floor(intent.offset)}` : "";
  // Every predicate — the caller's filters AND the grant's document filters — in one string,
  // built once. Both hybrid CTEs below interpolate this same value, which is the property that
  // makes hybrid as tightly scoped as the two single-mode paths. Two predicate builders is the
  // drift hazard grants/filters.ts already documents; this is the same rule one layer down.
  const whereClause = where.length ? ` where ${where.join(" and ")}` : "";

  if (mode === "hybrid" && vectorSlot && tsq) {
    // Reciprocal Rank Fusion. Chosen over a weighted sum of scores because ts_rank_cd and cosine
    // similarity are not on a common scale and have no principled conversion — RRF only uses each
    // list's ORDER, so there is no normalisation constant to get wrong. k=60 is the value from the
    // original paper and is not sensitive.
    //
    // The two CTEs both read `scoped`, so the grant's predicates are applied BEFORE either
    // ranking and before either LIMIT. Ranking first and filtering afterwards would leak: a
    // caller asking for 5 would get however many of the global top-5 their grant allows, and the
    // shortfall itself reports how many documents they cannot see.
    const K = 60;
    const pool = Math.min(MAX_LIMIT, Math.max(limit * 10, 50));
    const text2 =
      `with scoped as (select ${projection}, "document_id", tsv, embedding, "document_seq" from ${view} base${whereClause}), ` +
      `t as (select "document_id", row_number() over (order by ts_rank_cd(tsv, ${tsq}) desc) as rk ` +
      `from scoped where tsv @@ ${tsq} limit ${pool}), ` +
      `v as (select "document_id", row_number() over (order by embedding <=> ${vectorSlot}::vector) as rk ` +
      `from scoped where embedding is not null limit ${pool}) ` +
      `select scoped.*, ` +
      `(coalesce(1.0/(${K} + t.rk), 0) + coalesce(1.0/(${K} + v.rk), 0)) as "_rank" ` +
      `from scoped left join t on t."document_id" = scoped."document_id" ` +
      `left join v on v."document_id" = scoped."document_id" ` +
      `where t.rk is not null or v.rk is not null ` +
      `order by "_rank" desc limit ${limit}${offset}`;
    return { text: text2, values };
  }

  text += whereClause;

  if (intent.groupBy && intent.groupBy.length)
    text += ` group by ${intent.groupBy.map(q).join(", ")}`;

  // ORDER BY: when rankExpr present, relevance overrides intent.orderBy AND keyset — search
  // ranking and keyset pagination are mutually exclusive (refused in the verb before this is
  // called), and this is the enforcement of last resort: never emit two ORDER BYs.
  //
  // With keyset active, the pk tie-break is what makes the order TOTAL — the property a cursor
  // needs. Ties on the sort field alone would let two rows swap places between pages, which is
  // indistinguishable from losing or duplicating one.
  if (rankExpr) text += ` order by ${rankExpr} desc`;
  else if (opts.keyset) {
    const { field, pk, dir } = opts.keyset;
    text += ` order by ${q(field)} ${dir}, ${q(pk)} ${dir}`;
  } else if (intent.orderBy)
    text += ` order by ${q(intent.orderBy.field)} ${intent.orderBy.dir === "desc" ? "desc" : "asc"}`;

  text += ` limit ${limit}${offset}`;

  return { text, values };
}

/**
 * A to-one relation, as a correlated scalar subquery over the TARGET'S VIEW.
 *
 * Reading `v_<target>` rather than the target's table is the whole safety argument, and it is
 * three properties rather than one:
 *
 *   - the view already filters `_current and _rev_op <> 'delete'`, so a target with more than one
 *     revision yields one document rather than multiplying the host's;
 *   - the view already filters `workspace_id = current_setting(...)`, so there is no cross-tenant
 *     read to prevent by hand;
 *   - the view already carries `_acl` when the target sets `acl: true`, so the target document's
 *     own ACL applies with the same predicate the read path uses everywhere else.
 *
 * No grant on the target is evaluated: what is exposed is governed as fields of the HOST, under
 * the postures the host declared. The ACL is not a grant — it is a property of the document — so
 * skipping it would make a relation the way around one.
 *
 * `base` is the outer alias. Without it, `base."<on>"` would be an unqualified reference that
 * binds to the outer document only until the target grows a column of the same name.
 *
 * Built so a second cardinality (to-many) can be added later without restructuring: the masked
 * sub-column list and the ACL predicate are each built once, and only the final shape — a single
 * correlated object vs. a correlated array — would differ for that case.
 */
function relationExpr(
  env: "dev" | "live",
  field: string,
  rel: RelationDef,
  /** The TARGET column to join against — the column half of the host field's `fk`, never `on`. */
  targetColumn: string,
  param: (v: unknown) => string,
  opts: {
    relationPrincipals?: string[] | undefined;
    targetHasAcl?: ((collection: string) => boolean) | undefined;
  },
): string {
  const target = `${dataSchema(env)}.v_${rel.collection}`;
  // Bare identifiers, not `rel.`-prefixed: `rel` is the only relation inside the inner select,
  // so every unqualified name resolves to it — including the `"_acl"` that aclPredicate emits.
  // The one reference that must be qualified is `base.<on>`, which reaches OUT to the host
  // document, and it is.
  const subCols = Object.entries(rel.select).map(([name, def]) => {
    const mask = readPosture(def) === "mask" ? (def.mask ?? null) : null;
    return mask ? maskExpr(name, mask, param) : q(name);
  });
  const where = [`rel.${q(targetColumn)} = base.${q(rel.on)}`];
  if (opts.targetHasAcl?.(rel.collection) && opts.relationPrincipals)
    where.push(aclPredicate(param(opts.relationPrincipals)));
  return (
    `(select to_jsonb(r) from (select ${subCols.join(", ")} from ${target} rel` +
    ` where ${where.join(" and ")} limit 1) r) as ${q(field)}`
  );
}
