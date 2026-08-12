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
} from "../types";
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
import { makeAuditWriter, assertRecorded, type AuditWriter } from "../audit/decision";
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

export function makeProposeVerbs(d: VerbDeps) {
  const { app, cfg, pools } = d;

  // Locate a pending proposal by id. Only revisable collections have a _rev column at all —
  // scanning the rest throws `column "_rev" does not exist`.
  async function loadPending(
    client: PoolClient,
    env: "dev" | "live",
    schema: string,
    proposalId: string,
  ): Promise<{ collection: string; row: RevisionRow } | null> {
    for (const coll of revisableCollections(cfg)) {
      const c = findCollection(cfg, coll);
      if (!c) continue;
      // Every row this function hands back is later put to `admits()`, so it carries its ACL from
      // the start — one statement, one transaction, no window between the row and its policy.
      const q = await client.query(
        `select t.*${aclColumnSql(env, coll, c, "t")} from ${schema}.${ident(coll)} t
         where t._rev = $1 and t._rev_status = 'pending'`,
        [proposalId],
      );
      if (q.rowCount && q.rowCount > 0) return { collection: coll, row: q.rows[0] as RevisionRow };
    }
    return null;
  }

  // Approve and reject are deliberately NOT MCP tools — the untrusted model may propose, but not
  // decide. That is a surface restriction, and it is only half of the rule: the REST adapter
  // exposes both verbs to any bearer token, so the other half — that the decider is not the
  // proposer — is enforced in `checkFourEyes`, where no adapter can omit it.
  //
  // The body below is the sequence and nothing else: authorise, resolve what is being replaced,
  // merge, commit. Each of those four is a named function, because as one 200-line block the
  // security-relevant middle (four eyes, field coverage, the conflict scan) sat between two
  // stretches of bookkeeping and could only be reviewed by reading all of it.
  async function approveProposal(ctx: BrokerContext, proposalId: string): Promise<DecisionResult> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo);
    const schema = dataSchema(ctx.env);

    const pool = writePool(pools, ctx);
    if (!pool) return audit.refuse("*", "not_writable");

    try {
      return await withWorkspace(pool, ctx.workspaceId, async (client): Promise<DecisionResult> => {
        const found = await loadPending(client, ctx.env, schema, proposalId);
        if (!found) return audit.refuse("*", "not_found");
        const { collection: name, row: proposal } = found;

        const authorized = await authorizeApproval(ctx, audit, name, proposal);
        if (!authorized.ok) return authorized;
        const { collection: c, grant, pk } = authorized;

        const table = `${schema}.${ident(name)}`;
        const base = await resolveBase(client, ctx, audit, { name, c, grant, pk, table }, proposal);
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

        const rec = await audit.allow(name, { grant });
        assertRecorded(rec);
        return { ok: true as const, documentId: docId, rev: newRevId, auditId: rec.auditId };
      });
    } catch (err) {
      // 23505 here is the partial unique index on (workspace_id, pk) where _current (apply/ddl.ts):
      // another revision became current between this transaction's demote and its insert, so two
      // rows claimed _current at once. That is a lost race against a concurrent writer — the same
      // situation `expect` reports on the direct path — not a server fault. mutateFile already
      // maps it this way; reporting it as internal_error told the caller there was nothing to
      // retry and a bug to file.
      if ((err as { code?: string }).code === "23505") return audit.refuse("*", "conflict");
      console.error("[broker] approveProposal failed", { proposalId, err });
      return audit.refuse("*", "internal_error");
    }
  }

  // May THIS caller approve THIS proposal? Everything that can be answered from the proposal row,
  // the config and the approver's own grant, in the order it has always been asked in.
  async function authorizeApproval(
    ctx: BrokerContext,
    audit: AuditWriter,
    name: string,
    proposal: RevisionRow,
  ): Promise<
    | { ok: true; collection: CollectionConfig; grant: ActiveGrant; pk: string }
    | { ok: false; reason: MutationRefusalReason; auditId: AuditId }
  > {
    const c = findCollection(cfg, name);
    if (!c) return audit.refuse(name, "unknown_collection");

    const grant = await loadActiveGrant(app, ctx, name);
    if (!grant) return audit.refuse(name, "no_grant");

    // Four eyes, checked BEFORE the verb so the answer does not depend on the caller's own grant:
    // a proposer who lacks `approve` learns they cannot approve their own work either way.
    if (checkFourEyes(proposal, ctx)) return audit.refuse(name, "self_approval_denied", { grant });

    if (!grant.verbs.includes("approve")) return audit.refuse(name, "verb_denied", { grant });

    // Invariant: approve requires read coverage of every field in the proposal. Without this,
    // "approve, then read the diff" is a privilege-escalation path around field postures.
    for (const f of proposedFieldsOf(proposal))
      if (!grant.allowedFields.includes(f)) return audit.refuse(name, "field_denied", { grant });

    const pk = pkOf(c);
    if (!pk) return audit.refuse(name, "invalid_intent", { grant });

    // The filters must be evaluable before either branch below leans on them, and refused the
    // same way the read path refuses them — see grants/filters.ts.
    if (validateDocumentFilters(grant.documentFilter, c))
      return audit.refuse(name, "invalid_intent", { grant });

    return { ok: true, collection: c, grant, pk };
  }

  // What this proposal is being applied ON TOP OF: the document's current revision, or nothing for
  // a create. Also where the two questions that need the stored state are asked — does the
  // approver's grant admit this document, and has anything it touches moved since it was proposed.
  async function resolveBase(
    client: PoolClient,
    ctx: BrokerContext,
    audit: AuditWriter,
    scope: {
      name: string;
      c: CollectionConfig;
      grant: ActiveGrant;
      pk: string;
      table: string;
    },
    proposal: RevisionRow,
  ): Promise<
    | { ok: true; currentRev: RevisionRow | null }
    | { ok: false; reason: MutationRefusalReason; auditId: AuditId }
  > {
    const { name, c, grant, pk, table } = scope;

    if (proposal._rev_op === "create") {
      // No current revision yet, so the filter is checked against the proposed values.
      const tempDoc: Record<string, unknown> = {};
      for (const f of Object.keys(c.fields)) tempDoc[f] = proposal[f];
      // The ACL comes with it. A document that does not exist yet can still have one — an ACL is
      // keyed on the pk, and nothing stops it being written before the create is approved — and
      // dropping the column here would make `admits()` fail closed on every create proposal
      // against an ACL'd collection.
      if (Object.hasOwn(proposal, ACL_COLUMN)) tempDoc[ACL_COLUMN] = proposal[ACL_COLUMN];
      if (!admits(tempDoc, grant, c)) return audit.refuse(name, "not_found", { grant });
      return { ok: true, currentRev: null };
    }

    const currentQ = await client.query(
      `select t.*${aclColumnSql(ctx.env, name, c, "t")} from ${table} t
       where t.${ident(pk)} = $1 and t._current`,
      [proposal[pk]],
    );
    if (currentQ.rows.length === 0) return audit.refuse(name, "not_found", { grant });
    const currentRev = currentQ.rows[0] as RevisionRow;

    if (!admits(currentRev, grant, c)) return audit.refuse(name, "not_found", { grant });

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
      if (proposedFields.some((f) => changedSince.has(f)))
        return audit.refuse(name, "conflict", { grant });
    }

    return { ok: true, currentRev };
  }

  async function rejectProposal(
    ctx: BrokerContext,
    proposalId: string,
  ): Promise<
    { ok: true; auditId: AuditId } | { ok: false; reason: MutationRefusalReason; auditId: AuditId }
  > {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo);
    const schema = dataSchema(ctx.env);

    const pool = writePool(pools, ctx);
    if (!pool) return audit.refuse("*", "not_writable");

    try {
      return await withWorkspace(pool, ctx.workspaceId, async (client) => {
        const found = await loadPending(client, ctx.env, schema, proposalId);
        if (!found) return audit.refuse("*", "not_found");
        const { collection: collectionName, row: proposal } = found;

        const c = findCollection(cfg, collectionName);
        if (!c) return audit.refuse(collectionName, "unknown_collection");

        const grant = await loadActiveGrant(app, ctx, collectionName);
        if (!grant || !grant.verbs.includes("approve"))
          return audit.refuse(collectionName, "verb_denied", { grant: grant ?? null });

        // Rejecting your own proposal is closer to withdrawing it than to deciding on it, and
        // there is no withdraw verb — so it takes the same second person approve does. The rule
        // matters less here than the symmetry does: one decision verb enforcing four eyes and
        // its opposite not enforcing it is the kind of gap that reads as an oversight and gets
        // used as one. A proposal a proposer wants gone is rejected by a reviewer.
        if (proposal._rev_by === ctx.userId)
          return audit.refuse(collectionName, "self_approval_denied", { grant });

        // The same guard approveProposal states above. A collection with no primary key has no
        // document id to log, and `proposal.id ?? proposal.document_id` was guessing at column
        // names revision tables do not have — a miss wrote the string "undefined" into the change
        // log. Approve and reject refuse the same way instead.
        const pk = pkOf(c);
        if (!pk) return audit.refuse(collectionName, "invalid_intent", { grant });

        const table = `${schema}.${ident(collectionName)}`;
        await client.query(`update ${table} set _rev_status = 'rejected' where _rev = $1`, [
          proposalId,
        ]);

        const docId = String(proposal[pk]);
        await writeChangeLog(
          client,
          ctx,
          collectionName,
          docId,
          proposalId,
          proposal._rev_op,
          "rejected",
        );

        const rec = await audit.allow(collectionName, { grant });
        assertRecorded(rec);
        return { ok: true as const, auditId: rec.auditId };
      });
    } catch (err) {
      console.error("[broker] rejectProposal failed", { proposalId, err });
      return audit.refuse("*", "internal_error");
    }
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

  return { approveProposal, rejectProposal, listProposals, getProposal };
}
