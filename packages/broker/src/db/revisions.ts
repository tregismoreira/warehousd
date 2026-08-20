import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { REV_COLS, dataColsOf, type RevisionRow } from "../config/collection";
import type { CollectionConfig } from "../config/schema";
import { ident } from "../sql/ident";
import { encodeForColumn } from "./encode";

// The revision writer. Every dataset table carries the REV_COLS bookkeeping columns, and every
// path that adds a row to one goes through here: the direct write path (verbs/mutate.ts), the
// proposal path and its promotion (verbs/propose.ts), and the admin import path (import/run.ts).
//
// There were four verbatim copies of the insert below before this module existed. REV_COLS is a
// *positional* contract with the value array built beside it, so a column added to one copy and
// not the others shifts every value after it into the wrong column — silently, because the types
// are all `unknown`. One writer is the only way that stays impossible.

export type RevisionOp = "create" | "update" | "delete";
export type RevisionStatus = "pending" | "approved" | "rejected" | "superseded";

export type RevisionMeta = {
  seq: number;
  op: RevisionOp;
  status: RevisionStatus;
  // The field names this revision claims to have set. Empty for a delete: a tombstone changes no
  // field, and listing them would make the delete look like an edit in the change feed.
  fields: string[];
  base: number | null;
  current: boolean;
  // Deliberately not derived from a BrokerContext. On promotion, approveProposal writes the
  // *proposer* here rather than the approver, so authorship survives the merge — the audit row
  // is where the approver's identity is recorded.
  by: string;
  workspaceId: string;
};

// Seeders and fixtures write straight SQL against a dataset table rather than going through
// insertRevision — they run as the owner, before any broker exists, and they have no collection
// config to hand it. Every dataset is revisioned, so a bare `insert into data_live.people (...)`
// now fails on the NOT NULL bookkeeping columns. These two constants are the literal fragment
// that makes such an insert a well-formed `create` revision.
//
// `_rev`, `_rev_at` and `workspace_id` are omitted deliberately: each has a column default, and a
// seeder that spelled them out would be one more copy to keep in step with the DDL.
export const SEED_REV_COLUMNS = "_rev_seq, _rev_by, _rev_op, _rev_status, _rev_fields, _current";
export const SEED_REV_VALUES = "1, 'seed', 'create', 'approved', '{}', true";

/**
 * Append one revision row. Returns its `_rev`.
 *
 * `row` holds values in the shape node-postgres hands back on a READ — a `json` field is a JS
 * value, never serialised text. Both producers already satisfy that: `coerce()` parses rather than
 * stringifies, and a carried-forward column was parsed by the driver. The single rendering happens
 * in encodeForColumn below; a caller that serialises first gets its JSON stored as a JSON *string*,
 * which is why this is a contract and not a heuristic.
 */
export async function insertRevision(
  client: PoolClient,
  table: string,
  c: CollectionConfig,
  meta: RevisionMeta,
  row: Record<string, unknown>,
): Promise<string> {
  const revId = randomUUID();
  const dataCols = dataColsOf(c);
  const cols = [...REV_COLS, ...dataCols].map(ident).join(", ");
  // Positional, and in REV_COLS order. Do not reorder without reordering REV_COLS.
  const vals: unknown[] = [
    revId,
    meta.seq,
    new Date(),
    meta.by,
    meta.op,
    meta.status,
    meta.fields,
    meta.base,
    meta.current,
    meta.workspaceId,
    // `?? null` used to live here. It is inside encodeForColumn now, where the json case needs the
    // null test to come first anyway — `typeof null === "object"`.
    ...dataCols.map((k) => encodeForColumn(c.fields[k]?.type, row[k])),
  ];
  await client.query(
    `insert into ${table} (${cols}) values (${vals.map((_, i) => `$${i + 1}`).join(", ")})`,
    vals,
  );
  return revId;
}

/**
 * Clear `_current` on one revision. Always call this BEFORE inserting its replacement: both rows
 * are `_current` between the two statements otherwise, and the partial unique index on
 * (workspace_id, pk) where _current rejects the insert.
 */
export async function demoteRevision(
  client: PoolClient,
  table: string,
  rev: string,
): Promise<void> {
  await client.query(`update ${table} set _current = false where _rev = $1`, [rev]);
}

/**
 * The revision a document currently holds, or null if it has none (or was deleted).
 *
 * `aclSql` is the `, (...) as "_acl"` fragment from acl/sql.ts, or "" for a caller with no ACL to
 * evaluate. It is a REQUIRED parameter and not an optional one on purpose: `admits()` fails closed
 * when the column is absent, so a caller that forgets it would find every write to an ACL'd
 * collection refused rather than allowed — but the compiler naming the site is better than either.
 * The import path passes "": it runs as the operator, not as a principal, and there is no ACL for
 * it to be inside or outside of.
 */
export async function currentRevision(
  client: PoolClient,
  table: string,
  pk: string,
  id: unknown,
  aclSql: string,
): Promise<RevisionRow | null> {
  const r = await client.query(
    `select t.*${aclSql} from ${table} t where t.${ident(pk)} = $1 and t._current`,
    [id],
  );
  return r.rowCount ? (r.rows[0] as RevisionRow) : null;
}

/**
 * Demote the current revision and append its successor, carrying untouched columns forward so a
 * revision is a complete document rather than a patch. The shared shape behind "update" and
 * "delete" on both the direct path and the import path.
 */
export async function reviseDocument(
  client: PoolClient,
  table: string,
  c: CollectionConfig,
  current: RevisionRow,
  changed: Record<string, unknown>,
  meta: Pick<RevisionMeta, "op" | "status" | "by" | "workspaceId">,
): Promise<string> {
  const next: Record<string, unknown> = {};
  for (const f of dataColsOf(c)) next[f] = f in changed ? changed[f] : current[f];
  await demoteRevision(client, table, current._rev);
  return insertRevision(
    client,
    table,
    c,
    {
      seq: Number(current._rev_seq) + 1,
      op: meta.op,
      status: meta.status,
      fields: meta.op === "delete" ? [] : Object.keys(changed),
      base: Number(current._rev_seq),
      current: true,
      by: meta.by,
      workspaceId: meta.workspaceId,
    },
    next,
  );
}
