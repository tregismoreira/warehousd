import type { CollectionConfig, WarehousdConfig } from "./schema";
import { kindOf } from "./kinds";

// Four facts about a collection that the write path derives over and over: its primary key, its
// storable columns, the bookkeeping columns every revision carries, and which collections have
// revisions at all.
//
// Each had between three and eight verbatim copies across broker.ts. That is tolerable while the
// copies agree and silently wrong the moment one of them doesn't — `REV_COLS` in particular is a
// *positional* contract with the value list built beside it, so a column added to one copy and not
// the others shifts every value after it into the wrong column.

// The field that gives a dataset document its identity. `null` means the collection declares no
// pk, which is not a configuration error (a read-only lookup table needs none) but does mean
// nothing can address one of its documents — every caller here refuses rather than guessing.
export function pkOf(c: CollectionConfig): string | null {
  // Asked of the kind, not derived here: a file collection declares no pk at all — its identity is
  // `path` — and a fourth kind may key on something else again. See config/kinds/.
  return kindOf(c).pkField(c);
}

// The columns a revision actually stores, in a fixed order. A `view_join` field is computed by
// the collection's view and has no column on the base table (apply/ddl.ts skips it), so it is
// neither written nor carried forward.
export function dataColsOf(c: CollectionConfig): string[] {
  return (
    Object.entries(c.fields)
      // Neither a view_join nor a relation has a column on the base table: both are resolved at
      // read time, so nothing can be stranded in one and nothing can be written to one.
      .filter(([, f]) => !f.view_join && !f.relation)
      .map(([n]) => n)
  );
}

// The revision bookkeeping columns, in the order every insert below binds them. Frozen because the
// order is load-bearing: callers build a parallel value array and rely on index i naming column i.
export const REV_COLS: readonly string[] = Object.freeze([
  "_rev",
  "_rev_seq",
  "_rev_at",
  "_rev_by",
  "_rev_op",
  "_rev_status",
  "_rev_fields",
  "_rev_base",
  "_current",
  "workspace_id",
]);

// A revision row as the base table stores it: the bookkeeping columns REV_COLS names, plus one
// column per storable field. The data columns differ per collection and cannot be typed here, so
// they come through the index signature as `unknown` — which is honest, and is what forces the
// String()/Number() coercions at the points that use them.
//
// It replaces `proposal: any` and `currentRev: any`, under which `proposal._rev_by` (the four-eyes
// check) and `proposal._rev_op` were unchecked property reads on a value the compiler knew nothing
// about — a typo in either would have compiled and silently disabled the rule.
export type RevisionRow = {
  _rev: string;
  _rev_seq: number | string;
  _rev_at: Date | string;
  _rev_by: string;
  _rev_op: string;
  _rev_status: string;
  _rev_fields: string[] | null;
  _rev_base: number | string | null;
  _current: boolean;
  workspace_id: string;
} & Record<string, unknown>;

// Collections whose table carries revision columns: every dataset. tableDDL emits REV_COLS for
// all of them, because the admin import path needs update and delete and the only way to have
// those without giving the import role UPDATE/DELETE on data columns is to make both a new
// revision. File collections are append-only ingests and have no revisions.
export function revisionedCollections(cfg: WarehousdConfig): string[] {
  return (
    Object.entries(cfg.collections)
      // Every kind whose documents are rows carries the `_rev*` bookkeeping. A chunked kind is an
      // append-only ingest and has no revisions.
      .filter(([, c]) => !kindOf(c).chunked)
      .map(([name]) => name)
  );
}

// Collections a PROPOSAL can live in — narrower than the above, and deliberately so. Every
// dataset has the _rev_status column, but only a writable one can be written by a client, so
// only a writable one can hold a pending revision. Approve/reject scan for a proposal by id
// across collections; scanning the revisioned set instead would just be slower.
export function revisableCollections(cfg: WarehousdConfig): string[] {
  return (
    Object.entries(cfg.collections)
      // A kind whose documents are chunks of one blob has no revision to propose against: a file
      // collection is append-only and `update` is not among its supported verbs.
      .filter(([, c]) => c.writable && kindOf(c).supportedVerbs(c).includes("update"))
      .map(([name]) => name)
  );
}

/**
 * The data half of the revision a write will append: the values it STATES, over the values the
 * document already holds. One definition, because three paths were building it separately and a
 * security check is about to depend on all three agreeing.
 *
 * `current` is null for a create, and a field the write does not state is then the SQL NULL
 * insertRevision binds for it — nothing declares a column default. It is spelled as an explicit
 * `null` rather than left absent so the object is the whole document: a filter on a field nobody
 * stated must fail to match, which is what `col = NULL` does in SQL. (canonicalize returns null for
 * both absent and null, so the evaluator does not depend on this; the reader does.)
 *
 * `?? null` and not `||`: `false` and `0` are values a document may hold.
 */
export function nextDataRow(
  c: CollectionConfig,
  current: Record<string, unknown> | null,
  stated: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const f of dataColsOf(c)) next[f] = f in stated ? stated[f] : (current?.[f] ?? null);
  return next;
}

// The one mapping from a context's env to the schema holding that env's data. dev is synthetic,
// live is real; nothing else may decide this. sql/build.ts spells the same rule for the *views*
// it reads, which live in the same two schemas.
export function dataSchema(env: "dev" | "live"): "data_live" | "data_synth" {
  return env === "live" ? "data_live" : "data_synth";
}

/** Postgres truncates an identifier past this many bytes, which would make two declared indexes
 *  collide silently. A config rule refuses instead. */
export const MAX_IDENTIFIER_BYTES = 63;

/**
 * The name of a declared index.
 *
 * Deterministic, so `applyConfig` and the schema planner agree about which index a config entry
 * refers to without storing a mapping. The `_ix_` infix is the ownership marker: `reflectIndexes`
 * in apply/plan.ts considers only names carrying it, so an index an operator created by hand in
 * `<project>/migrations/*.sql` can never be proposed for dropping.
 */
export function indexName(collection: string, fields: string[]): string {
  return `${collection}_ix_${fields.join("_")}`;
}
