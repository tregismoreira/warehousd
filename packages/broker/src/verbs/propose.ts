import { randomUUID } from "node:crypto";
import { kindOf } from "../config/kinds";
import type { PoolClient } from "pg";
import type {
  BrokerContext,
  Document,
  MutationIntent,
  MutationRefusalReason,
  MutationResult,
  RefusalReason,
  AuditId,
  ProposalAction,
  BatchDecision,
  BatchDecisionOutcome,
  BatchDecisionResult,
} from "../types";
import { MAX_BATCH_DECISIONS } from "../types";
import type { CollectionConfig } from "../config/schema";
import { ACL_COLUMN } from "../config/schema";
import type { ActiveGrant } from "../grants/eval";
import { loadActiveGrant, loadActiveGrants } from "../grants/eval";
import { admits, validateDocumentFilters } from "../grants/filters";
import { withWorkspace, writePool } from "../db/pools";
import { insertRevision, demoteRevision } from "../db/revisions";
import { findCollection, maskedFieldsFor } from "../config/load";
import {
  pkOf,
  dataColsOf,
  revisableCollections,
  dataSchema,
  type RevisionRow,
} from "../config/collection";
import { ident } from "../sql/ident";
import { aclColumnSql } from "../acl/sql";
import { coerce } from "../import/validate";
import {
  makeAuditWriter,
  assertRecorded,
  AuditWriteFailed,
  type AuditWriter,
} from "../audit/decision";
import { BatchDecisionsIntentSchema, checkIntent } from "../intents/schema";
import { writeChangeLog } from "./history";
import type { VerbDeps } from "./deps";

export type ProposalSummary = {
  proposalId: string;
  collection: string;
  op: string;
  fields: string[];
  proposedBy: string;
  proposedAt: string;
  documentId: string;
};

export type DecisionResult =
  | { ok: true; documentId: string; rev: string; auditId: AuditId }
  | { ok: false; reason: MutationRefusalReason; auditId: AuditId };

// The proposal path: a write that parks as a pending revision, and the two verbs that decide on
// one. `proposeDataset` is exported for verbs/mutate.ts, which routes to it when the grant's mode
// is proposal_only — the branch belongs to mutate, the mechanics belong here.
export async function proposeDataset(
  d: VerbDeps,
  ctx: BrokerContext,
  audit: AuditWriter,
  intent: MutationIntent,
  c: CollectionConfig,
  grant: ActiveGrant,
): Promise<MutationResult> {
  const schema = dataSchema(ctx.env);
  const table = `${schema}.${ident(intent.collection)}`;
  const pk = pkOf(c);
  if (!pk) return audit.refuseMutation(intent, grant, "invalid_intent");

  const submitted = intent.op === "delete" ? {} : intent.values;
  const coerced: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(submitted)) {
    const r = coerce(value, c.fields[name]!);
    if (!r.ok) return audit.refuseMutation(intent, grant, "invalid_value");
    coerced[name] = r.value;
  }

  const dataCols = dataColsOf(c);

  const pool = writePool(d.pools, ctx);
  if (!pool) return audit.refuseMutation(intent, grant, "not_writable");

  try {
    return await withWorkspace(pool, ctx.workspaceId, async (client) => {
      if (intent.op === "create") {
        let docId = coerced[pk];
        if (docId === undefined && c.fields[pk]!.type === "uuid") {
          docId = randomUUID();
          coerced[pk] = docId;
        }
        if (docId === undefined) return audit.refuseMutation(intent, grant, "invalid_intent");
        // The pk value came out of `coerced`, whose values are `unknown` to the compiler. Anything
        // non-scalar would stringify to "[object Object]"; it is a pk, so it is a scalar — but say
        // that once, here, rather than at each use.
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const documentId = String(docId);

        const clash = await client.query(
          `select 1 from ${table} where ${ident(pk)} = $1 and (_current or _rev_status = 'pending')`,
          [docId],
        );
        if ((clash.rowCount ?? 0) > 0) return audit.refuseMutation(intent, grant, "conflict");

        // Not current: a pending revision is invisible to every read path until it is approved.
        const revId = await insertRevision(
          client,
          table,
          dataCols,
          {
            seq: 1,
            op: "create",
            status: "pending",
            fields: Object.keys(coerced),
            base: null,
            current: false,
            by: ctx.userId,
            workspaceId: ctx.workspaceId,
          },
          coerced,
        );

        await writeChangeLog(
          client,
          ctx,
          intent.collection,
          documentId,
          revId,
          "create",
          "pending",
        );
        const rec = await audit.allowMutation(intent, grant, Object.keys(coerced));
        assertRecorded(rec);
        return {
          ok: true as const,
          status: "pending" as const,
          proposalId: revId,
          auditId: rec.auditId,
        };
      }

      // update and delete: fetch current revision (with its ACL) and create pending
      const cur = await client.query(
        `select t.*${aclColumnSql(ctx.env, intent.collection, c, "t")} from ${table} t
         where t.${ident(pk)} = $1 and t._current`,
        [intent.id],
      );
      if (cur.rowCount === 0) return audit.refuseMutation(intent, grant, "not_found");
      const current = cur.rows[0] as RevisionRow;

      if (!admits(current, grant, c)) return audit.refuseMutation(intent, grant, "not_found");

      const isDelete = intent.op === "delete";
      // For pending revisions, _rev_fields holds the proposed field names and the data columns
      // hold the proposed state. Not `current`, and no demotion: the document keeps the revision
      // it has until someone approves this one. That is why this cannot call reviseDocument.
      const next: Record<string, unknown> = {};
      for (const f of dataCols) next[f] = f in coerced ? coerced[f] : current[f];

      const revId = await insertRevision(
        client,
        table,
        dataCols,
        {
          seq: Number(current._rev_seq) + 1,
          op: isDelete ? "delete" : "update",
          status: "pending",
          fields: isDelete ? [] : Object.keys(coerced),
          base: Number(current._rev_seq),
          current: false,
          by: ctx.userId,
          workspaceId: ctx.workspaceId,
        },
        next,
      );

      await writeChangeLog(
        client,
        ctx,
        intent.collection,
        String(intent.id),
        revId,
        isDelete ? "delete" : "update",
        "pending",
      );
      const rec = await audit.allowMutation(intent, grant, isDelete ? [] : Object.keys(coerced));
      assertRecorded(rec);
      return {
        ok: true as const,
        status: "pending" as const,
        proposalId: revId,
        auditId: rec.auditId,
      };
    });
  } catch (err) {
    console.error("[broker] proposeDataset failed", { collection: intent.collection, err });
    return audit.refuseMutation(intent, grant, "internal_error");
  }
}

// The field names a pending revision claims to change. Stored as `_rev_fields`; read through one
// accessor so "a proposal with no listed fields" is the same empty list everywhere.
function proposedFieldsOf(proposal: RevisionRow): string[] {
  return proposal._rev_fields ?? [];
}

// Four eyes. A proposal exists so that something other than the proposer decides, and the approve
// verb alone does not make the approver that something.
//
// This was previously left to "approve is not an MCP tool", which held only while the model was the
// only proposer. The REST adapter exposes approveProposal to any bearer token — including a
// headless API key — so a single credential holding verbs: ["update", "approve"] could propose and
// approve in two calls, and the pending state that exists to interpose a person interposed nobody.
export function checkFourEyes(
  proposal: Pick<RevisionRow, "_rev_by">,
  ctx: Pick<BrokerContext, "userId">,
): boolean {
  return proposal._rev_by === ctx.userId;
}

// May THIS caller decide on THIS proposal? Everything that can be answered from the proposal row,
// the config and the decider's own grant — no `await`, no database access. Extracted from what
// used to be `authorizeApproval` so it can be reasoned about, and tested, without a transaction:
// it is the one part of a decision that is pure, and the part that most needs an independent test.
//
// `c` and `grant` are resolved by the caller (a config lookup and a grant load respectively) and
// handed in, rather than looked up here, because the grant load is a database call and this
// function may not make one. Both may be null: `c` when the collection named on the proposal no
// longer exists in config, `grant` when the decider holds none — and the reason each of those
// carries no grant on the refusal is that there was never one to name.
//
// The checks and their order are exactly `authorizeApproval`'s, unchanged, for `action ===
// "approve"`. For `action === "reject"` this applies exactly the (narrower) subset
// `rejectProposal` has always applied: collection, then grant-plus-approve-verb collapsed into one
// `verb_denied` (rejectProposal never told the two apart), then four eyes, then pk. Reject never
// reads a proposal's values, so it has no field-coverage check, and it never promotes a merged row
// for `admits()` to test, so it has no document-filter check either — widening or narrowing either
// path here would be a real behaviour change, not a refactor.
export function authorizeDecision(
  ctx: Pick<BrokerContext, "userId">,
  name: string,
  c: CollectionConfig | null,
  grant: ActiveGrant | null,
  proposal: RevisionRow,
  action: ProposalAction,
):
  | { ok: true; pk: string }
  | { ok: false; reason: MutationRefusalReason; grant: ActiveGrant | null } {
  if (!c) return { ok: false, reason: "unknown_collection", grant: null };

  if (action === "reject") {
    if (!grant || !grant.verbs.includes("approve"))
      return { ok: false, reason: "verb_denied", grant: grant ?? null };

    // Rejecting your own proposal is closer to withdrawing it than to deciding on it, and there is
    // no withdraw verb — so it takes the same second person approve does.
    if (checkFourEyes(proposal, ctx)) return { ok: false, reason: "self_approval_denied", grant };

    const pk = pkOf(c);
    if (!pk) return { ok: false, reason: "invalid_intent", grant };

    return { ok: true, pk };
  }

  if (!grant) return { ok: false, reason: "no_grant", grant: null };

  // Four eyes, checked BEFORE the verb so the answer does not depend on the caller's own grant:
  // a proposer who lacks `approve` learns they cannot approve their own work either way.
  if (checkFourEyes(proposal, ctx)) return { ok: false, reason: "self_approval_denied", grant };

  if (!grant.verbs.includes("approve")) return { ok: false, reason: "verb_denied", grant };

  // Invariant: approve requires read coverage of every field in the proposal. Without this,
  // "approve, then read the diff" is a privilege-escalation path around field postures.
  for (const f of proposedFieldsOf(proposal))
    if (!grant.allowedFields.includes(f)) return { ok: false, reason: "field_denied", grant };

  const pk = pkOf(c);
  if (!pk) return { ok: false, reason: "invalid_intent", grant };

  // The filters must be evaluable before either branch below leans on them, and refused the
  // same way the read path refuses them — see grants/filters.ts.
  if (validateDocumentFilters(grant.documentFilter, c))
    return { ok: false, reason: "invalid_intent", grant };

  return { ok: true, pk };
}

// The state the document will hold once this proposal is applied: the current revision with the
// proposal's own changed fields laid over it, and the sequence number that state gets.
//
// Pure, and separated for that reason — it is the one part of approval that can be reasoned about
// (and tested) without a transaction, and the merge rule is the part a reader most needs to check.
export function mergeRevision(
  c: CollectionConfig,
  proposal: RevisionRow,
  currentRev: RevisionRow | null,
): { merged: Record<string, unknown>; newSeq: number } {
  const dataCols = dataColsOf(c);
  const merged: Record<string, unknown> = {};
  // Start from what the document holds now; a create has nothing to start from, so it starts from
  // the proposal itself.
  for (const f of dataCols) merged[f] = (currentRev ?? proposal)[f];
  // Then the proposal's own changes, and only those: a field the proposal did not touch keeps
  // whatever value it acquired while the proposal was pending.
  for (const f of proposedFieldsOf(proposal)) if (dataCols.includes(f)) merged[f] = proposal[f];

  // _rev_seq counts the states the document actually held, so it comes from the revision being
  // replaced rather than from max(_rev_seq).
  //
  // max() counted the pending row too — the proposal being approved is itself in this table — so
  // every approval skipped a number: a document with two real revisions reported seqs 1 and 3.
  // Deriving it from the current revision keeps the sequence contiguous, and matches what
  // mutateDataset does on the direct path (`Number(current._rev_seq) + 1`).
  const newSeq = proposal._rev_op === "create" ? 1 : Number(currentRev!._rev_seq) + 1;
  return { merged, newSeq };
}

// Write the merged state and retire what it replaces. Demote first, then promote: the partial
// unique index on (workspace_id, pk) where _current refuses two current rows, so the order is not a
// preference.
export async function commitRevision(
  client: PoolClient,
  ctx: BrokerContext,
  args: {
    table: string;
    collection: string;
    c: CollectionConfig;
    proposal: RevisionRow;
    currentRev: RevisionRow | null;
    merged: Record<string, unknown>;
    newSeq: number;
    pk: string;
  },
): Promise<string> {
  const { table, c, proposal, currentRev, merged, newSeq } = args;

  if (currentRev) await demoteRevision(client, table, currentRev._rev);

  // `_rev_by` carries the PROPOSER, not the approver: authorship survives the merge, and the
  // approver's identity is the audit row's job.
  const newRevId = await insertRevision(
    client,
    table,
    dataColsOf(c),
    {
      seq: newSeq,
      op: proposal._rev_op as "create" | "update" | "delete",
      status: "approved",
      fields: proposedFieldsOf(proposal),
      base: proposal._rev_base === null ? null : Number(proposal._rev_base),
      current: true,
      by: proposal._rev_by,
      workspaceId: ctx.workspaceId,
    },
    merged,
  );

  // The pending row was consumed by the merged revision above, so it is marked `superseded`, not
  // `approved`. Flipping it to `approved` left two approved rows carrying the same `_rev_fields`
  // and `_rev_by`: the document's history showed every approval twice, and listRevisions could not
  // tell which of the pair was the state the document held.
  //
  // It is kept rather than removed — the write role holds no DELETE, and the row is the record of
  // what was *proposed*, which the merged row does not preserve when the merge pulled in
  // concurrent changes.
  await client.query(`update ${table} set _rev_status = 'superseded' where _rev = $1`, [
    proposal._rev,
  ]);

  return newRevId;
}

// What this proposal is being applied ON TOP OF: the document's current revision, or nothing for
// a create. Also where the two questions that need the stored state are asked — does the
// approver's grant admit this document, and has anything it touches moved since it was proposed.
//
// Called only by applyApproval, immediately below — reject never resolves a base, because it
// never promotes a merged row.
async function resolveBase(
  client: PoolClient,
  ctx: BrokerContext,
  name: string,
  c: CollectionConfig,
  grant: ActiveGrant,
  pk: string,
  table: string,
  proposal: RevisionRow,
): Promise<
  { ok: true; currentRev: RevisionRow | null } | { ok: false; reason: MutationRefusalReason }
> {
  if (proposal._rev_op === "create") {
    // No current revision yet, so the filter is checked against the proposed values.
    const tempDoc: Record<string, unknown> = {};
    for (const f of Object.keys(c.fields)) tempDoc[f] = proposal[f];
    // The ACL comes with it. A document that does not exist yet can still have one — an ACL is
    // keyed on the pk, and nothing stops it being written before the create is approved — and
    // dropping the column here would make `admits()` fail closed on every create proposal
    // against an ACL'd collection.
    if (Object.hasOwn(proposal, ACL_COLUMN)) tempDoc[ACL_COLUMN] = proposal[ACL_COLUMN];
    if (!admits(tempDoc, grant, c)) return { ok: false, reason: "not_found" };
    return { ok: true, currentRev: null };
  }

  const currentQ = await client.query(
    `select t.*${aclColumnSql(ctx.env, name, c, "t")} from ${table} t
     where t.${ident(pk)} = $1 and t._current`,
    [proposal[pk]],
  );
  if (currentQ.rows.length === 0) return { ok: false, reason: "not_found" };
  const currentRev = currentQ.rows[0] as RevisionRow;

  if (!admits(currentRev, grant, c)) return { ok: false, reason: "not_found" };

  // If any field in proposal._rev_fields was changed after _rev_base, the proposal was written
  // against a state that no longer exists.
  const proposedFields = proposedFieldsOf(proposal);
  if (proposal._rev_base !== null && proposedFields.length > 0) {
    const conflictQ = await client.query(
      `select _rev_fields from ${table}
       where ${ident(pk)} = $1 and _rev_status = 'approved' and _rev_seq > $2
       order by _rev_seq asc`,
      [proposal[pk], proposal._rev_base],
    );
    const changedSince = new Set<string>();
    for (const row of conflictQ.rows)
      for (const f of (row._rev_fields ?? []) as string[]) changedSince.add(f);
    if (proposedFields.some((f) => changedSince.has(f))) return { ok: false, reason: "conflict" };
  }

  return { ok: true, currentRev };
}

// The transactional work of approving one proposal: resolve what it replaces, merge, commit,
// log — everything `authorizeDecision` already cleared for. Split from it (and from the driver in
// `decideProposals`) so the security-relevant decision and the data writes are two different
// things a reader can check separately.
export async function applyApproval(
  client: PoolClient,
  ctx: BrokerContext,
  name: string,
  c: CollectionConfig,
  grant: ActiveGrant,
  proposal: RevisionRow,
  pk: string,
  table: string,
): Promise<
  | { ok: true; documentId: string; rev?: string | undefined }
  | { ok: false; reason: MutationRefusalReason }
> {
  const base = await resolveBase(client, ctx, name, c, grant, pk, table, proposal);
  if (!base.ok) return base;
  const currentRev = base.currentRev;

  const { merged, newSeq } = mergeRevision(c, proposal, currentRev);
  const newRevId = await commitRevision(client, ctx, {
    table,
    collection: name,
    c,
    proposal,
    currentRev,
    merged,
    newSeq,
    pk,
  });

  const docId = String(merged[pk] ?? proposal[pk]);
  await writeChangeLog(client, ctx, name, docId, newRevId, proposal._rev_op, "approved");

  return { ok: true, documentId: docId, rev: newRevId };
}

// The transactional work of rejecting one proposal. No merge, no promoted row: the pending
// revision is simply retired, and the change log names it by its own `_rev`.
export async function applyRejection(
  client: PoolClient,
  ctx: BrokerContext,
  name: string,
  _c: CollectionConfig,
  proposal: RevisionRow,
  pk: string,
  table: string,
): Promise<
  | { ok: true; documentId: string; rev?: string | undefined }
  | { ok: false; reason: MutationRefusalReason }
> {
  await client.query(`update ${table} set _rev_status = 'rejected' where _rev = $1`, [
    proposal._rev,
  ]);

  const docId = String(proposal[pk]);
  await writeChangeLog(client, ctx, name, docId, proposal._rev, proposal._rev_op, "rejected");

  return { ok: true, documentId: docId };
}

// Raised inside `decideProposals`' transaction to abort it on the first refused decision —
// module-private, like `UnsupportedFilter` in sql/build.ts. `withWorkspace` rolls back on any
// thrown error; this one just carries no information of its own; `failed` (a closure variable set
// immediately before the throw) is what the driver's catch block reads back.
class BatchAborted extends Error {}

// The one proposal (if any) whose refusal aborted the batch, and why — see `decideProposals`.
type FailedDecision = {
  proposalId: string;
  reason: MutationRefusalReason;
  grant: ActiveGrant | null;
  collection: string | null;
};

export function makeProposeVerbs(d: VerbDeps) {
  const { app, cfg, pools } = d;

  // Locate every pending proposal in `ids` at once, one query per revisable collection rather than
  // one per collection PER id — the change that makes a 40-item batch cost O(collections) queries
  // instead of O(collections × proposals). Every row this function hands back is later put to
  // `admits()`, so it carries its ACL from the start — one statement, one transaction, no window
  // between the row and its policy, exactly as the single-id form already guaranteed.
  async function loadPendingMany(
    client: PoolClient,
    env: "dev" | "live",
    schema: string,
    ids: string[],
  ): Promise<Map<string, { collection: string; row: RevisionRow }>> {
    const out = new Map<string, { collection: string; row: RevisionRow }>();
    if (ids.length === 0) return out;
    for (const coll of revisableCollections(cfg)) {
      if (out.size === ids.length) break; // every id already located
      const c = findCollection(cfg, coll);
      if (!c) continue;
      const q = await client.query(
        `select t.*${aclColumnSql(env, coll, c, "t")} from ${schema}.${ident(coll)} t
         where t._rev = any($1) and t._rev_status = 'pending'`,
        [ids],
      );
      for (const row of q.rows as RevisionRow[])
        if (!out.has(row._rev)) out.set(row._rev, { collection: coll, row });
    }
    return out;
  }

  // Locate a pending proposal by id. A one-id wrapper over loadPendingMany, kept for the callers
  // (getProposal, the single-decision wrappers below) that only ever want one.
  async function loadPending(
    client: PoolClient,
    env: "dev" | "live",
    schema: string,
    proposalId: string,
  ): Promise<{ collection: string; row: RevisionRow } | null> {
    const found = await loadPendingMany(client, env, schema, [proposalId]);
    return found.get(proposalId) ?? null;
  }

  // The atomic driver behind approveProposal, rejectProposal, and POST /v1/proposals/decide.
  //
  // One transaction for the whole list: every decision is individually grant-checked
  // (authorizeDecision), applied (applyApproval/applyRejection), and — only once every one of
  // them succeeds — audited, still inside the transaction. The first refusal aborts the whole
  // batch by throwing BatchAborted, which rolls everything back; the refusal path below then
  // re-derives one audit row per input decision, named `batch_aborted` for everyone but the one
  // that actually failed. Nothing is committed and nothing is audited as an allow unless every
  // decision in the batch would have succeeded on its own.
  async function decideProposals(ctx: BrokerContext, raw: unknown): Promise<BatchDecisionResult> {
    const batchId = randomUUID();
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo, batchId);
    const schema = dataSchema(ctx.env);

    const envelopeRefusal = async (reason: MutationRefusalReason): Promise<BatchDecisionResult> => {
      await audit.refuse("*", reason);
      return { ok: false, batchId, reason, failedProposalId: null, decisions: [] };
    };

    const parsed = checkIntent(BatchDecisionsIntentSchema, raw, "decideProposals");
    if (!parsed.ok) return envelopeRefusal("invalid_intent");
    const decisions: BatchDecision[] = parsed.intent.decisions;

    if (decisions.length > MAX_BATCH_DECISIONS) return envelopeRefusal("invalid_intent");

    // A duplicate is ambiguous — approve then reject the same proposal? — and refusing is cheaper
    // than defining a precedence rule nobody asked for.
    const seen = new Set<string>();
    for (const dcn of decisions) {
      if (seen.has(dcn.proposalId)) return envelopeRefusal("invalid_intent");
      seen.add(dcn.proposalId);
    }

    const pool = writePool(pools, ctx);
    if (!pool) return envelopeRefusal("not_writable");

    // Set inside the transaction the moment a decision refuses, and read back afterward to build
    // the refusal path. `null` after a rollback means no single decision was at fault — the
    // AuditWriteFailed and "anything else" branches below, where the whole batch is the casualty
    // of something that is not any one proposal's problem.
    //
    // Read back through `getFailed()` rather than the bare variable: TypeScript's flow analysis
    // does not see past the `withWorkspace` closure's assignments, so it narrows the bare
    // variable's apparent type to `null` after the `await` — a function boundary re-establishes
    // the declared type instead of a non-null assertion papering over the gap.
    let failed: FailedDecision | null = null;
    const getFailed = (): FailedDecision | null => failed;
    let abortReason: MutationRefusalReason = "internal_error";

    // What every input decision resolved to, whether or not it was ever reached by the
    // authorize/apply loop below — populated before that loop runs, from the batch's own
    // loadPendingMany/loadActiveGrants calls, so the refusal path can still name the right
    // collection and grant on a decision the loop never got to.
    const resolved = new Map<string, { collection: string | null; grant: ActiveGrant | null }>();

    try {
      const outcomes = await withWorkspace(
        pool,
        ctx.workspaceId,
        async (client): Promise<BatchDecisionOutcome[]> => {
          const ids = decisions.map((dcn) => dcn.proposalId);
          const found = await loadPendingMany(client, ctx.env, schema, ids);

          const names = [...new Set([...found.values()].map((f) => f.collection))];
          const grants = await loadActiveGrants(app, ctx, names);

          for (const dcn of decisions) {
            const entry = found.get(dcn.proposalId);
            const collection = entry?.collection ?? null;
            resolved.set(dcn.proposalId, {
              collection,
              grant: collection ? (grants.get(collection) ?? null) : null,
            });
          }

          const applied: BatchDecisionOutcome[] = [];
          for (const dcn of decisions) {
            const entry = found.get(dcn.proposalId);
            if (!entry) {
              failed = {
                proposalId: dcn.proposalId,
                reason: "not_found",
                grant: null,
                collection: null,
              };
              throw new BatchAborted();
            }
            const { collection: name, row: proposal } = entry;
            const c = findCollection(cfg, name);
            const grant = grants.get(name) ?? null;

            const authorized = authorizeDecision(ctx, name, c, grant, proposal, dcn.action);
            if (!authorized.ok) {
              failed = {
                proposalId: dcn.proposalId,
                reason: authorized.reason,
                grant: authorized.grant,
                collection: name,
              };
              throw new BatchAborted();
            }
            if (!c || !grant) {
              // Unreachable: authorizeDecision's own first checks (unknown_collection, then
              // no_grant/reject's collapsed verb_denied) already refuse whenever either is null,
              // so `authorized.ok` implies both are non-null here. A thrown error, rather than a
              // non-null assertion, is what keeps that relationship visible to the compiler
              // instead of silently trusted.
              throw new Error("authorizeDecision returned ok without a resolved collection/grant");
            }

            const table = `${schema}.${ident(name)}`;
            let applyResult;
            try {
              applyResult =
                dcn.action === "approve"
                  ? await applyApproval(client, ctx, name, c, grant, proposal, authorized.pk, table)
                  : await applyRejection(client, ctx, name, c, proposal, authorized.pk, table);
            } catch (err) {
              // Caught here, at the decision it happened to, rather than only by the outer catch:
              // a lost race is a property of THIS proposal, not of the batch, and the caller (or
              // the one-item wrapper) should be told so by name instead of `batch_aborted`, which
              // would be true but strictly less informative for a batch of one.
              if ((err as { code?: string }).code === "23505") {
                failed = {
                  proposalId: dcn.proposalId,
                  reason: "conflict",
                  grant,
                  collection: name,
                };
                throw new BatchAborted();
              }
              throw err;
            }

            if (!applyResult.ok) {
              failed = {
                proposalId: dcn.proposalId,
                reason: applyResult.reason,
                grant,
                collection: name,
              };
              throw new BatchAborted();
            }

            applied.push({
              proposalId: dcn.proposalId,
              action: dcn.action,
              ok: true,
              documentId: applyResult.documentId,
              rev: applyResult.rev,
              auditId: null,
            });
          }

          // Every decision in the batch succeeded — write the per-proposal audit rows now, still
          // inside the transaction, so an audit write that fails here rolls everything back too
          // (assertRecorded throws AuditWriteFailed, caught below).
          const final: BatchDecisionOutcome[] = [];
          for (const outcome of applied) {
            const info = resolved.get(outcome.proposalId);
            const rec = await audit.allow(info?.collection ?? null, { grant: info?.grant ?? null });
            assertRecorded(rec);
            final.push({ ...outcome, auditId: rec.auditId });
          }
          return final;
        },
      );

      return { ok: true, batchId, decisions: outcomes };
    } catch (err) {
      if (err instanceof BatchAborted) {
        const f = getFailed();
        if (f) abortReason = f.reason;
      } else if (err instanceof AuditWriteFailed) {
        abortReason = "internal_error";
      } else if ((err as { code?: string }).code === "23505") {
        // The partial unique index on (workspace_id, pk) where _current (apply/ddl.ts): another
        // revision became current between this transaction's demote and its insert. A lost race
        // against a concurrent writer, not a server fault — see approveProposal's own history of
        // this mapping, preserved here for the batch path.
        abortReason = "conflict";
      } else {
        console.error("[broker] decideProposals failed", { batchId, err });
        abortReason = "internal_error";
      }
    }

    // The refusal path, run after the rollback and outside the transaction: one audit row per
    // input decision, in the caller's order. The proposal `failed` names (if any) keeps its own
    // real reason; every other entry — decided or not — is recorded as `batch_aborted`, because it
    // was neither approved nor rejected once the transaction it lived in rolled back.
    const f = getFailed();
    const failedProposalId = f ? f.proposalId : null;
    const failedReason = f ? f.reason : abortReason;
    const outcomes: BatchDecisionOutcome[] = [];
    for (const dcn of decisions) {
      const isFailing = dcn.proposalId === failedProposalId;
      const reason: MutationRefusalReason = isFailing ? failedReason : "batch_aborted";
      const info = resolved.get(dcn.proposalId);
      const rec = await audit.refuse(info?.collection ?? "*", reason, {
        grant: info?.grant ?? null,
      });
      outcomes.push({
        proposalId: dcn.proposalId,
        action: dcn.action,
        ok: false,
        reason,
        auditId: rec.auditId,
      });
    }

    return { ok: false, batchId, reason: abortReason, failedProposalId, decisions: outcomes };
  }

  // Approve and reject are deliberately NOT MCP tools — the untrusted model may propose, but not
  // decide. That is a surface restriction, and it is only half of the rule: the REST adapter
  // exposes both verbs to any bearer token, so the other half — that the decider is not the
  // proposer — is enforced in `checkFourEyes`, where no adapter can omit it.
  //
  // Both are now one-item batches through decideProposals: one implementation of four eyes, field
  // coverage and the conflict scan, rather than two. A one-item batch can never produce
  // `batch_aborted` as its OWN outcome, because the failing item, if any, is the only item — but
  // `result.reason` is what stays authoritative even when it can: a single-item batch that aborts
  // on a driver error not tied to any one decision (a lost race, an audit outage) still names the
  // real reason at the envelope level while its lone per-item outcome is generically
  // `batch_aborted` — see decideProposals' refusal path. The wrapper always reports
  // `result.reason`, and recovers the real `auditId` from `decisions[0]` when one was written.
  async function approveProposal(ctx: BrokerContext, proposalId: string): Promise<DecisionResult> {
    const result = await decideProposals(ctx, { decisions: [{ proposalId, action: "approve" }] });
    if (!result.ok) {
      const outcome = result.decisions[0];
      return { ok: false, reason: result.reason, auditId: outcome ? outcome.auditId : null };
    }
    const outcome = result.decisions[0];
    if (!outcome) {
      // Unreachable: a successful batch's `decisions` always carries one entry per input
      // decision, and this input is always exactly one. A defensive refusal, rather than a
      // non-null assertion, is what keeps that relationship visible to the compiler —
      // `noUncheckedIndexedAccess` still types the lookup as possibly `undefined`.
      console.error("[broker] approveProposal: successful batch returned no outcome", {
        proposalId,
      });
      return { ok: false, reason: "internal_error", auditId: null };
    }
    if (!outcome.ok) {
      // Cannot happen: result.ok is true only when every decision in the batch succeeded.
      console.error("[broker] approveProposal: successful batch contained a refused outcome", {
        proposalId,
      });
      return { ok: false, reason: "internal_error", auditId: outcome.auditId };
    }
    if (outcome.rev === undefined) {
      // Cannot happen: applyApproval always returns a rev, and this is the "approve" branch of a
      // one-item batch — only a reject's outcome ever omits one. A defensive refusal here, rather
      // than a non-null assertion, is what keeps that relationship visible instead of trusted.
      console.error("[broker] approveProposal: batch outcome missing rev", { proposalId });
      return { ok: false, reason: "internal_error", auditId: outcome.auditId };
    }
    return {
      ok: true,
      documentId: outcome.documentId,
      rev: outcome.rev,
      auditId: outcome.auditId,
    };
  }

  async function rejectProposal(
    ctx: BrokerContext,
    proposalId: string,
  ): Promise<
    { ok: true; auditId: AuditId } | { ok: false; reason: MutationRefusalReason; auditId: AuditId }
  > {
    const result = await decideProposals(ctx, { decisions: [{ proposalId, action: "reject" }] });
    if (!result.ok) {
      const outcome = result.decisions[0];
      return { ok: false, reason: result.reason, auditId: outcome ? outcome.auditId : null };
    }
    const outcome = result.decisions[0];
    if (!outcome) {
      // Unreachable — see the matching branch in approveProposal above.
      console.error("[broker] rejectProposal: successful batch returned no outcome", {
        proposalId,
      });
      return { ok: false, reason: "internal_error", auditId: null };
    }
    if (!outcome.ok) {
      console.error("[broker] rejectProposal: successful batch contained a refused outcome", {
        proposalId,
      });
      return { ok: false, reason: "internal_error", auditId: outcome.auditId };
    }
    return { ok: true, auditId: outcome.auditId };
  }

  // What a reviewer may see BEFORE deciding: metadata and the names of the fields a proposal
  // touches — never their values. A reviewer fetches content with getDocument, where postures
  // are already enforced; duplicating values into this listing would be a posture bypass.
  //
  // It reads the revision tables through the WRITE pool, because that is the only role with
  // SELECT on base tables — the read roles see views, and a view shows only current,
  // non-tombstoned revisions, which is exactly the set a pending proposal is not in.
  async function listProposals(
    ctx: BrokerContext,
    opts: {
      collection?: string | undefined;
      status?: "pending" | "approved" | "rejected" | undefined;
    } = {},
  ): Promise<
    | { ok: true; proposals: ProposalSummary[]; auditId: AuditId }
    | { ok: false; reason: RefusalReason; auditId: AuditId }
  > {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo);
    const auditCollection = opts.collection ?? "*";

    const pool = writePool(pools, ctx);
    if (!pool) return audit.refuse(auditCollection, "internal_error");

    const schema = dataSchema(ctx.env);
    // A proposal's lifecycle is pending → approved | rejected, and that is the vocabulary the
    // caller uses. `superseded` is how the approved case is *stored*: approveProposal writes a
    // merged revision and marks the proposal row superseded, so asking the table for
    // `_rev_status = 'approved'` would return the merged revisions — which are revisions, not
    // proposals — and miss every proposal that was actually approved.
    //
    // Before the statuses were separated, `status=approved` matched both the proposal row and the
    // revision that replaced it, so this listing returned every approval twice.
    const status = opts.status ?? "pending";
    const storedStatus = status === "approved" ? "superseded" : status;
    const names = opts.collection ? [opts.collection] : Object.keys(cfg.collections);

    try {
      // Fresh on every call, like every other grant check — one round trip for the whole list
      // rather than one per collection. No approve verb → that collection is simply absent from
      // the feed, not a refusal: a reviewer learning which collections they cannot approve for is
      // itself a disclosure.
      const grants = await loadActiveGrants(app, ctx, names);

      const proposals = await withWorkspace(pool, ctx.workspaceId, async (client) => {
        const out: ProposalSummary[] = [];
        for (const name of names) {
          const c = findCollection(cfg, name);
          // Only revisable collections have proposals at all.
          if (!c || !c.writable || kindOf(c).chunked) continue;

          const grant = grants.get(name);
          if (!grant || !grant.verbs.includes("approve")) continue;
          // A grant whose filters cannot be evaluated contributes nothing, for the same reason a
          // grant without `approve` does. `admits` would already drop every row; skipping here
          // says so outright and spares the query.
          if (validateDocumentFilters(grant.documentFilter, c)) continue;

          // Bookkeeping columns only, plus the document-filter field when one is set, plus the
          // ACL. Selecting `*` would pull ungranted values into memory even if they were never
          // returned, and "denied means absent" means never fetched, not filtered afterwards.
          const pk = pkOf(c);
          const cols = ["_rev", "_rev_op", "_rev_fields", "_rev_by", "_rev_at"];
          if (pk) cols.push(pk);
          for (const f of grant.documentFilter)
            if (Object.hasOwn(c.fields, f.field) && !cols.includes(f.field)) cols.push(f.field);

          const q = await client.query(
            `select ${cols.map((col) => `t.${ident(col)}`).join(", ")}${aclColumnSql(ctx.env, name, c, "t")}
             from ${schema}.${ident(name)} t
             where t._rev_status = $1 order by t._rev_at`,
            [storedStatus],
          );

          for (const row of q.rows) {
            if (!admits(row, grant, c)) continue;
            out.push({
              proposalId: row._rev,
              collection: name,
              op: row._rev_op,
              fields: row._rev_fields ?? [],
              proposedBy: row._rev_by,
              proposedAt: row._rev_at,
              documentId: String(pk ? row[pk] : ""),
            });
          }
        }
        return out;
      });

      const rec = await audit.allow(auditCollection);
      if (!rec.ok) return rec;
      return { ok: true as const, proposals, auditId: rec.auditId };
    } catch (err) {
      console.error("[broker] listProposals failed", { err });
      return audit.refuse(auditCollection, "internal_error");
    }
  }

  // The proposed values of a pending revision, reduced to the fields the reviewer may read.
  //
  // listProposals deliberately returns changed field NAMES and no values, and getDocument
  // cannot help for a `create`: the document is not in any view until it is approved, so a
  // reviewer would be asked to approve content they cannot see. This reads the pending
  // revision itself, through the same grant and posture gates as any other read — a reviewer
  // sees a proposed value only where their own grant would have let them read that field.
  async function getProposal(
    ctx: BrokerContext,
    proposalId: string,
  ): Promise<
    | {
        ok: true;
        collection: string;
        op: string;
        documentId: string;
        proposedBy: string;
        proposedAt: string;
        fields: string[];
        values: Document;
        maskedFields: string[];
        fieldsReturned: string[];
        auditId: AuditId;
      }
    | { ok: false; reason: RefusalReason; auditId: AuditId }
  > {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo);
    const pool = writePool(pools, ctx);
    if (!pool) return audit.refuse("*", "internal_error");

    const schema = dataSchema(ctx.env);

    try {
      const found = await withWorkspace(pool, ctx.workspaceId, (client) =>
        loadPending(client, ctx.env, schema, proposalId),
      );

      if (!found) return audit.refuse("*", "not_found");
      const { collection: coll, row } = found;

      const c = findCollection(cfg, coll);
      if (!c) return audit.refuse(coll, "unknown_collection");

      const grant = await loadActiveGrant(app, ctx, coll);
      // Approving is the act this read exists to inform, so it is gated on `approve`, not
      // merely `read` — matching approveProposal's own requirement.
      if (!grant || !grant.verbs.includes("read") || !grant.verbs.includes("approve"))
        return audit.refuse(coll, "no_grant", { grant: grant ?? null });

      // As in query and mutate: an unevaluable filter is the grant's problem, reported the same
      // way everywhere rather than as a missing document.
      if (validateDocumentFilters(grant.documentFilter, c))
        return audit.refuse(coll, "invalid_intent", { grant });

      // `loadPending` fetched the row with its ACL, so this is the whole of the question — the
      // filters and the per-document policy at once.
      if (!admits(row, grant, c)) return audit.refuse(coll, "not_found", { grant });

      const pk = pkOf(c);
      if (!pk) return audit.refuse(coll, "invalid_intent", { grant });

      // Same rule as every other read: a field is visible only if the grant carries it.
      const readable = grant.allowedFields.filter((f) => Object.hasOwn(c.fields, f));

      // Masked fields are ELIDED here rather than transformed.
      //
      // Every other read path masks in SQL, so the raw value never leaves Postgres. This one
      // cannot: it reads the pending revision through the write pool with `select *`, and the
      // row is already in memory by the time the grant is known. Masking it here would mean a
      // second implementation of maskExpr in TypeScript — and two evaluators of one rule is the
      // drift hazard grants/filters.ts already documents at length.
      //
      // So the value is withheld and the field is named. A reviewer learns that the proposal
      // touches `ssn` without learning either the proposed value or the current one, which is
      // enough to decide whether the change is in scope — and getDocument, which does mask
      // properly, is where they look if they need the content.
      const masked = new Set(maskedFieldsFor(cfg, coll, grant.unmaskedFields));
      const values: Document = {};
      for (const f of readable) if (!masked.has(f)) values[f] = row[f];

      const rec = await audit.allow(coll, {
        fieldsReturned: readable.filter((f) => !masked.has(f)),
        unmaskedFields: readable.filter((f) => grant.unmaskedFields.includes(f)),
        grant,
      });
      if (!rec.ok) return rec;

      return {
        ok: true,
        collection: coll,
        op: String(row._rev_op),
        documentId: String(row[pk]),
        proposedBy: String(row._rev_by),
        proposedAt: new Date(row._rev_at).toISOString(),
        fields: row._rev_fields ?? [],
        values,
        // The names of the fields whose values were withheld, so a reviewer can tell "this
        // proposal does not touch ssn" from "it does and you may not see the value".
        maskedFields: readable.filter((f) => masked.has(f)),
        fieldsReturned: readable.filter((f) => !masked.has(f)),
        auditId: rec.auditId,
      };
    } catch (err) {
      console.error("[broker] getProposal failed", { proposalId, err });
      return audit.refuse("*", "internal_error");
    }
  }

  return { approveProposal, rejectProposal, listProposals, getProposal, decideProposals };
}
