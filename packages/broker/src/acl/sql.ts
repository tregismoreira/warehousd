import { ACL_COLUMN, ACL_TABLE, type CollectionConfig } from "../config/schema";
import { dataSchema } from "../config/collection";
import { ident, literal } from "../sql/ident";
import { kindOf } from "../config/kinds";

// The two SQL forms of one rule, and nothing else.
//
// `aclPredicate` is what the READ path ANDs into its WHERE clause: the view already carries an
// `_acl` column (apply/ddl.ts joins it in), so the predicate only has to compare it. It is a fixed
// clause emitted by the broker and never composed from caller input — the only caller-derived
// thing in it is the principal set, which arrives as a bound parameter like every other value
// (invariant 2).
//
// `aclColumnSql` is what the WRITE path needs instead. The write path reads BASE tables for the
// `_rev*` bookkeeping columns, which the view does not expose, so it cannot reuse the read path's
// SQL — it has to carry the ACL onto the row itself and evaluate it in process. A correlated
// scalar subquery rather than a join, because the queries it is spliced into are otherwise
// `select *` and adding a join would change what `*` means.
//
// Deliberately NOT a new document-filter operator. Adding `or`/`not_in` to the filter algebra
// would mean the two evaluators (sql/build.ts and grants/filters.ts) had to agree about a much
// larger language, which is exactly the drift hazard grants/filters.ts was written to close.

/**
 * `slot` is the placeholder holding the caller's principal set — always a bound parameter.
 *
 * Parenthesised because the caller joins predicates with ` and `, and an unbracketed `or` would
 * swallow every predicate to its left.
 */
export function aclPredicate(slot: string): string {
  const col = ident(ACL_COLUMN);
  return `(coalesce(array_length(${col}, 1), 0) = 0 or ${col} && ${slot}::text[])`;
}

/**
 * The `, (...) as "_acl"` fragment a base-table query appends so the row it fetches carries its
 * ACL, or "" for a collection that has none.
 *
 * Returning "" rather than a null literal is deliberate: `admits()` distinguishes an absent column
 * (the caller did not ask) from a null one (there is no ACL row), and only the second is public.
 * A collection with `acl: false` has no ACL to be absent, so `admits()` never looks.
 *
 * `alias` is the alias the caller gave the base table. The collection name goes through
 * `literal()` rather than being interpolated bare: it is IDENT-validated at config load and so
 * cannot carry a quote today, which is precisely the argument that stops holding the first time
 * something else reaches here.
 */
export function aclColumnSql(
  env: "dev" | "live",
  collection: string,
  c: CollectionConfig,
  alias: string,
): string {
  if (!c.acl) return "";
  // Which column an ACL row is matched against — the declared pk for a dataset, `path` for a
  // file. Asked of the kind so this and the view's join cannot key on different things.
  const key = kindOf(c).aclKeyField(c);
  // CollectionSchema refuses `acl: true` on a kind with no ACL key, so this is unreachable
  // through a parsed config. It is here because a hand-built config object (most of the test
  // suite) can skip zod, and emitting a subquery keyed on nothing would be worse than none.
  if (!key) return "";
  const schema = dataSchema(env);
  return (
    `, (select a.principals from ${schema}.${ident(ACL_TABLE)} a` +
    ` where a.workspace_id = ${alias}.workspace_id and a.collection = ${literal(collection)}` +
    ` and a.document_id = ${alias}.${ident(key)}::text) as ${ident(ACL_COLUMN)}`
  );
}
