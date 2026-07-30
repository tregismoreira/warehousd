import type { CollectionConfig, WarehousdConfig } from "./schema";

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
  return Object.entries(c.fields).find(([, f]) => f.pk)?.[0] ?? null;
}

// The columns a revision actually stores, in a fixed order. A `view_join` field is computed by
// the collection's view and has no column on the base table (apply/ddl.ts skips it), so it is
// neither written nor carried forward.
export function dataColsOf(c: CollectionConfig): string[] {
  return Object.entries(c.fields).filter(([, f]) => !f.view_join).map(([n]) => n);
}

// The revision bookkeeping columns, in the order every insert below binds them. Frozen because the
// order is load-bearing: callers build a parallel value array and rely on index i naming column i.
export const REV_COLS: readonly string[] = Object.freeze([
  "_rev", "_rev_seq", "_rev_at", "_rev_by", "_rev_op", "_rev_status",
  "_rev_fields", "_rev_base", "_current", "org_id",
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
  org_id: string;
} & Record<string, unknown>;

// Collections that carry revision columns. A proposal only ever lives in one of these, and the
// _rev/_rev_status columns exist nowhere else — see tableDDL, which emits them only for writable
// non-file datasets. Approve/reject scan for a proposal by id across collections, so they must
// scan this set rather than every configured collection.
export function revisableCollections(cfg: WarehousdConfig): string[] {
  return Object.entries(cfg.collections)
    .filter(([, c]) => c.writable && c.type !== "file")
    .map(([name]) => name);
}

// The one mapping from a context's env to the schema holding that env's data. dev is synthetic,
// live is real; nothing else may decide this. sql/build.ts spells the same rule for the *views*
// it reads, which live in the same two schemas.
export function dataSchema(env: "dev" | "live"): "data_live" | "data_synth" {
  return env === "live" ? "data_live" : "data_synth";
}
