import type { PoolClient } from "pg";
import type { BrokerContext, MutationIntent, MutationResult } from "../types";
import type { VerbDeps } from "./deps";
import { dataColsOf } from "../config/collection";
import { ident } from "../sql/ident";
import { withWorkspace } from "../db/pools";
import { makeAuditWriter } from "../audit/decision";
import { resolveHistoryGrant, admitsDocument } from "./history";

export type MutateVerb = (ctx: BrokerContext, intent: MutationIntent) => Promise<MutationResult>;

/**
 * Restore a document to a past revision.
 *
 * This verb deliberately owns NO write path. It reads the target revision's stored values,
 * diffs them against the current revision, and hands `mutate` an ordinary update intent
 * carrying only the fields that differ. Grants, per-field write postures, document filters,
 * per-document ACLs, proposal_only routing, optimistic concurrency, the revision writer, the
 * change feed and the single audit call all come from there, unchanged — for every target
 * revision that differs from the current one.
 *
 * A target revision that does NOT differ is the one path that never reaches `mutate`: there is
 * nothing to write, so nothing to hand it. That path authorises itself, through the same
 * collection/grant/verb/document-filter ladder and the same per-document admits() check the
 * read verbs in history.ts run (`resolveHistoryGrant`, `admitsDocument`) — reused rather than
 * copied, with `update` added to the verbs it requires because a revert writes, not merely
 * reads. Without that, a noop revert would tell an unauthorised caller whether a document (and a
 * revision of it) exists, which "denied means absent" forbids.
 *
 * Two consequences worth naming, because both are answers to questions that would otherwise be
 * re-litigated:
 *
 * - The refusal is all-or-nothing. `mutate` refuses `field_not_writable` for any named field
 *   the caller cannot write, and it refuses before writing anything. A partial revert would
 *   produce a document state that never existed, which is worse than a refusal.
 * - Only DIFFERING fields are named, so reverting a title never demands write on a field that
 *   did not move.
 *
 * Values are read RAW, never through the read path's masking projection. A masked value written
 * back would store the mask. They are held only long enough to build the intent and are never
 * returned: the result carries a document id and a revision id, as every mutation does.
 */
export function makeRevertVerb(d: VerbDeps, mutate: MutateVerb) {
  async function revertDocument(
    ctx: BrokerContext,
    opts: { collection: string; id: string; rev: string; expect?: string },
  ): Promise<MutationResult> {
    const audit = makeAuditWriter(d.app, ctx, d.auditEnabled, d.auditTo);
    const name = opts.collection;
    // Every early refusal below names the same intent shape: an update against the document the
    // caller asked to revert, with no values yet decided. `mutationIntent` (audit/decision.ts)
    // reads only `op`, `collection` and `id` off it before values are known, so an empty `values`
    // here records the truth — nothing has been touched yet.
    const stub: MutationIntent = { op: "update", collection: name, id: opts.id, values: {} };

    // Collection, grant, verbs, document filter, pk — the same ladder history.ts's read verbs
    // run, asked for `read` (to see history at all) and `update` (because a revert writes).
    const opened = await resolveHistoryGrant(d, ctx, name, ["read", "update"]);
    if (!opened.ok) return audit.refuseMutation(stub, opened.grant, opened.reason);
    const { c, grant, pool, pk, schema } = opened;

    // Stored columns minus the primary key: reverting must never rewrite document identity.
    const cols = dataColsOf(c).filter((f) => f !== pk);

    let outcome:
      | { found: false }
      | { found: true; target: Record<string, unknown>; current: Record<string, unknown> };
    try {
      outcome = await withWorkspace(pool, ctx.workspaceId, async (client: PoolClient) => {
        const q = await client.query(
          `select _rev, _current, ${cols.map(ident).join(", ")} from ${schema}.${ident(name)}
            where workspace_id=$1 and ${ident(pk)}=$2 and (_rev=$3 or _current)
              and _rev_status <> 'superseded'`,
          [ctx.workspaceId, opts.id, opts.rev],
        );
        const target = q.rows.find((r) => String(r._rev) === opts.rev);
        const current = q.rows.find((r) => r._current === true);
        if (!target || !current) return { found: false };

        // The same admission check history's reads run before returning anything: the grant's
        // document filter and the document's CURRENT acl, not the target revision's.
        if (!(await admitsDocument(client, ctx, name, c, grant, pk, schema, opts.id)))
          return { found: false };

        return { found: true, target, current };
      });
    } catch (err) {
      console.error("[broker] revertDocument failed", { collection: name, id: opts.id, err });
      return audit.refuseMutation(stub, grant, "internal_error");
    }

    // A missing revision, a missing document, and a document the grant's filter or ACL excludes
    // all read the same: not_found. Telling them apart would be exactly the oracle "denied means
    // absent" forbids — for a nonexistent revision as much as for a nonexistent document.
    if (!outcome.found) return audit.refuseMutation(stub, grant, "not_found");

    const values: Record<string, unknown> = {};
    for (const f of cols) {
      const before = outcome.current[f];
      const after = outcome.target[f];
      if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) values[f] = after;
    }

    if (Object.keys(values).length === 0) {
      const rec = await audit.allowMutation({ ...stub, values: {} }, grant, []);
      if (!rec.ok) return rec;
      return { ok: true, status: "noop", documentId: opts.id, auditId: rec.auditId };
    }

    return mutate(ctx, {
      op: "update",
      collection: name,
      id: opts.id,
      values,
      ...(opts.expect ? { expect: opts.expect } : {}),
    });
  }

  return { revertDocument };
}
