import { randomUUID } from "node:crypto";
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
import type { ActiveGrant } from "../grants/eval";
import { loadActiveGrant } from "../grants/eval";
import { matchesFilters, validateDocumentFilters } from "../grants/filters";
import { withOrg, writePool } from "../db/pools";
import { findCollection } from "../config/load";
import {
  pkOf,
  dataColsOf,
  revisableCollections,
  dataSchema,
  REV_COLS,
  type RevisionRow,
} from "../config/collection";
import { ident } from "../sql/ident";
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
  if (!pk) return audit.refuseMutation(intent, grant.id, "invalid_intent");

  const submitted = intent.op === "delete" ? {} : intent.values;
  const coerced: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(submitted)) {
    const r = coerce(value, c.fields[name]!);
    if (!r.ok) return audit.refuseMutation(intent, grant.id, "invalid_value");
    coerced[name] = r.value;
  }

  const dataCols = dataColsOf(c);

  const pool = writePool(d.pools, ctx);
  if (!pool) return audit.refuseMutation(intent, grant.id, "not_writable");

  try {
    return await withOrg(pool, ctx.orgId, async (client) => {
      if (intent.op === "create") {
        let docId = coerced[pk];
        if (docId === undefined && c.fields[pk]!.type === "uuid") {
          docId = randomUUID();
          coerced[pk] = docId;
        }
        if (docId === undefined) return audit.refuseMutation(intent, grant.id, "invalid_intent");
        // The pk value came out of `coerced`, whose values are `unknown` to the compiler. Anything
        // non-scalar would stringify to "[object Object]"; it is a pk, so it is a scalar — but say
        // that once, here, rather than at each use.
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const documentId = String(docId);

        const clash = await client.query(
          `select 1 from ${table} where ${ident(pk)} = $1 and (_current or _rev_status = 'pending')`,
          [docId],
        );
        if ((clash.rowCount ?? 0) > 0) return audit.refuseMutation(intent, grant.id, "conflict");

        const revId = randomUUID();
        const cols = [...REV_COLS, ...dataCols].map(ident).join(", ");
        const vals: unknown[] = [
          revId,
          1,
          new Date(),
          ctx.userId,
          "create",
          "pending",
          Object.keys(coerced),
          null,
          false,
          ctx.orgId,
          ...dataCols.map((k) => coerced[k] ?? null),
        ];
        await client.query(
          `insert into ${table} (${cols}) values (${vals.map((_, i) => `$${i + 1}`).join(", ")})`,
          vals,
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
        const rec = await audit.allowMutation(intent, grant.id, Object.keys(coerced));
        assertRecorded(rec);
        return {
          ok: true as const,
          status: "pending" as const,
          proposalId: revId,
          auditId: rec.auditId,
        };
      }

      // update and delete: fetch current revision and create pending
      const cur = await client.query(
        `select * from ${table} where ${ident(pk)} = $1 and _current`,
        [intent.id],
      );
      if (cur.rowCount === 0) return audit.refuseMutation(intent, grant.id, "not_found");
      const current = cur.rows[0] as RevisionRow;

      if (!matchesFilters(current, grant.documentFilter, c))
        return audit.refuseMutation(intent, grant.id, "not_found");

      const isDelete = intent.op === "delete";
      // For pending revisions, store the proposed changes in _rev_fields (the field names).
      // The data columns store the proposed state (the values).
      const next: Record<string, unknown> = {};
      for (const f of dataCols) next[f] = f in coerced ? coerced[f] : current[f];

      const revId = randomUUID();
      const cols = [...REV_COLS, ...dataCols].map(ident).join(", ");
      const vals: unknown[] = [
        revId,
        Number(current._rev_seq) + 1,
        new Date(),
        ctx.userId,
        isDelete ? "delete" : "update",
        "pending",
        isDelete ? [] : Object.keys(coerced),
        Number(current._rev_seq),
        false,
        ctx.orgId,
        ...dataCols.map((k) => next[k] ?? null),
      ];
      await client.query(
        `insert into ${table} (${cols}) values (${vals.map((_, i) => `$${i + 1}`).join(", ")})`,
        vals,
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
      const rec = await audit.allowMutation(intent, grant.id, isDelete ? [] : Object.keys(coerced));
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
    return audit.refuseMutation(intent, grant.id, "internal_error");
  }
}

export function makeProposeVerbs(d: VerbDeps) {
  const { app, cfg, pools } = d;

  // Locate a pending proposal by id. Only revisable collections have a _rev column at all —
  // scanning the rest throws `column "_rev" does not exist`.
  async function findPending(
    client: PoolClient,
    schema: string,
    proposalId: string,
  ): Promise<{ collection: string; row: RevisionRow } | null> {
    for (const coll of revisableCollections(cfg)) {
      const q = await client.query(
        `select * from ${schema}.${ident(coll)} where _rev = $1 and _rev_status = 'pending'`,
        [proposalId],
      );
      if (q.rowCount && q.rowCount > 0) return { collection: coll, row: q.rows[0] as RevisionRow };
    }
    return null;
  }

  // Approve and reject are deliberately NOT MCP tools — the untrusted model may propose, but not
  // decide. That is a surface restriction, and it is only half of the rule: the REST adapter
  // exposes both verbs to any bearer token, so the other half — that the decider is not the
  // proposer — is enforced below against `_rev_by`, where no adapter can omit it.
  async function approveProposal(ctx: BrokerContext, proposalId: string): Promise<DecisionResult> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled);
    const schema = dataSchema(ctx.env);

    // Find the proposal by proposalId
    const pool = writePool(pools, ctx);
    if (!pool) return audit.refuse("*", "not_writable");

    try {
      return await withOrg(pool, ctx.orgId, async (client): Promise<DecisionResult> => {
        const found = await findPending(client, schema, proposalId);
        if (!found) return audit.refuse("*", "not_found");
        const { collection: collectionName, row: proposal } = found;

        const c = findCollection(cfg, collectionName);
        if (!c) return audit.refuse(collectionName, "unknown_collection");

        // Load the approver's grant
        const grant = await loadActiveGrant(app, ctx, collectionName);
        if (!grant) return audit.refuse(collectionName, "no_grant");

        // Four eyes. A proposal exists so that something other than the proposer decides, and
        // the approve verb alone does not make the approver that something.
        //
        // This was previously left to "approve is not an MCP tool", which held only while the
        // model was the only proposer. The REST adapter exposes approveProposal to any bearer
        // token — including a headless API key — so a single credential holding
        // verbs: ["update", "approve"] could propose and approve in two calls, and the pending
        // state that exists to interpose a person interposed nobody.
        //
        // Checked before the verb, so the answer does not depend on the caller's own grant: a
        // proposer who lacks `approve` learns they cannot approve their own work either way.
        if (proposal._rev_by === ctx.userId)
          return audit.refuse(collectionName, "self_approval_denied", { grantId: grant.id });

        // Require approve verb
        if (!grant.verbs.includes("approve"))
          return audit.refuse(collectionName, "verb_denied", { grantId: grant.id });

        // Invariant: approve requires read coverage of every field in the proposal. Without this,
        // "approve, then read the diff" is a privilege-escalation path around field postures.
        const proposedFields: string[] = proposal._rev_fields ?? [];
        for (const f of proposedFields) {
          if (!grant.allowedFields.includes(f))
            return audit.refuse(collectionName, "field_denied", { grantId: grant.id });
        }

        // Get the pk field for this collection
        const pk = pkOf(c);
        if (!pk) return audit.refuse(collectionName, "invalid_intent", { grantId: grant.id });

        const table = `${schema}.${ident(collectionName)}`;

        // The filters must be evaluable before either branch below leans on them, and refused
        // the same way the read path refuses them — see grants/filters.ts.
        if (validateDocumentFilters(grant.documentFilter, c))
          return audit.refuse(collectionName, "invalid_intent", { grantId: grant.id });

        // Check document filter for approver
        let currentRev: RevisionRow | null = null;
        if (proposal._rev_op === "create") {
          // For create proposals, there's no current revision yet. We need to check if the proposed
          // values would pass the filter. For now, we'll build a temporary object to check.
          const tempDoc: Record<string, unknown> = {};
          for (const f of Object.keys(c.fields)) {
            tempDoc[f] = proposal[f];
          }
          if (!matchesFilters(tempDoc, grant.documentFilter, c))
            return audit.refuse(collectionName, "not_found", { grantId: grant.id });
        } else {
          // For update/delete, fetch the current revision
          const currentQ = await client.query(
            `select * from ${table} where ${ident(pk)} = $1 and _current`,
            [proposal[pk]],
          );
          if (currentQ.rows.length === 0)
            return audit.refuse(collectionName, "not_found", { grantId: grant.id });
          currentRev = currentQ.rows[0] as RevisionRow;

          // Check document filter
          if (!matchesFilters(currentRev, grant.documentFilter, c))
            return audit.refuse(collectionName, "not_found", { grantId: grant.id });

          // Conflict check: if any field in proposal._rev_fields was changed after _rev_base,
          // refuse with conflict. Scan revisions with _rev_seq > _rev_base and _rev_status = 'approved'.
          if (proposal._rev_base !== null && proposedFields.length > 0) {
            const conflictQ = await client.query(
              `select _rev_fields from ${table}
               where ${ident(pk)} = $1 and _rev_status = 'approved' and _rev_seq > $2
               order by _rev_seq asc`,
              [proposal[pk], proposal._rev_base],
            );

            const changedSince = new Set<string>();
            for (const row of conflictQ.rows) {
              const fields: string[] = row._rev_fields ?? [];
              for (const f of fields) changedSince.add(f);
            }

            // Check for overlap
            const overlap = proposedFields.some((f) => changedSince.has(f));
            if (overlap) return audit.refuse(collectionName, "conflict", { grantId: grant.id });
          }
        }

        // Promotion: merge the proposal with the current state
        const dataCols = dataColsOf(c);

        // Build the merged row: start with current, overwrite with proposal's changes
        const merged: Record<string, unknown> = {};
        if (currentRev) {
          for (const f of dataCols) merged[f] = currentRev[f];
        } else {
          // Create case: use proposal values
          for (const f of dataCols) merged[f] = proposal[f];
        }
        // Overwrite with proposed changes
        for (const f of proposedFields) {
          if (dataCols.includes(f)) {
            merged[f] = proposal[f];
          }
        }

        // _rev_seq counts the states the document actually held, so it comes from the revision
        // being replaced rather than from max(_rev_seq).
        //
        // max() counted the pending row too — the proposal being approved is itself in this table —
        // so every approval skipped a number: a document with two real revisions reported seqs 1
        // and 3. Deriving it from the current revision keeps the sequence contiguous, and matches
        // what mutateDataset does on the direct path (`Number(current._rev_seq) + 1`).
        const newSeq = proposal._rev_op === "create" ? 1 : Number(currentRev!._rev_seq) + 1;

        // Write the new current revision
        const newRevId = randomUUID();
        const cols = [...REV_COLS, ...dataCols].map(ident).join(", ");
        const vals: unknown[] = [
          newRevId,
          newSeq,
          new Date(),
          proposal._rev_by,
          proposal._rev_op,
          "approved",
          proposal._rev_fields,
          proposal._rev_base,
          true,
          ctx.orgId,
          ...dataCols.map((k) => merged[k] ?? null),
        ];

        // If there's a current revision, demote it BEFORE promoting the new one
        if (currentRev) {
          await client.query(`update ${table} set _current = false where _rev = $1`, [
            currentRev._rev,
          ]);
        }

        // Insert the new merged revision
        await client.query(
          `insert into ${table} (${cols}) values (${vals.map((_, i) => `$${i + 1}`).join(", ")})`,
          vals,
        );

        // The pending row was consumed by the merged revision above, so it is marked `superseded`,
        // not `approved`. Flipping it to `approved` left two approved rows carrying the same
        // `_rev_fields` and `_rev_by`: the document's history showed every approval twice, and
        // listRevisions could not tell which of the pair was the state the document held.
        //
        // It is kept rather than removed — the write role holds no DELETE, and the row is the
        // record of what was *proposed*, which the merged row does not preserve when the merge
        // pulled in concurrent changes.
        await client.query(`update ${table} set _rev_status = 'superseded' where _rev = $1`, [
          proposalId,
        ]);

        // Get the document ID for the response
        const docId = String(merged[pk] ?? proposal[pk]);

        await writeChangeLog(
          client,
          ctx,
          collectionName,
          docId,
          newRevId,
          proposal._rev_op,
          "approved",
        );

        const rec = await audit.allow(collectionName, { grantId: grant.id });
        assertRecorded(rec);
        return { ok: true as const, documentId: docId, rev: newRevId, auditId: rec.auditId };
      });
    } catch (err) {
      // 23505 here is the partial unique index on (org_id, pk) where _current (apply/ddl.ts):
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

  async function rejectProposal(
    ctx: BrokerContext,
    proposalId: string,
  ): Promise<
    { ok: true; auditId: AuditId } | { ok: false; reason: MutationRefusalReason; auditId: AuditId }
  > {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled);
    const schema = dataSchema(ctx.env);

    const pool = writePool(pools, ctx);
    if (!pool) return audit.refuse("*", "not_writable");

    try {
      return await withOrg(pool, ctx.orgId, async (client) => {
        const found = await findPending(client, schema, proposalId);
        if (!found) return audit.refuse("*", "not_found");
        const { collection: collectionName, row: proposal } = found;

        const grant = await loadActiveGrant(app, ctx, collectionName);
        if (!grant || !grant.verbs.includes("approve"))
          return audit.refuse(collectionName, "verb_denied", { grantId: grant?.id ?? null });

        // Rejecting your own proposal is closer to withdrawing it than to deciding on it, and
        // there is no withdraw verb — so it takes the same second person approve does. The rule
        // matters less here than the symmetry does: one decision verb enforcing four eyes and
        // its opposite not enforcing it is the kind of gap that reads as an oversight and gets
        // used as one. A proposal a proposer wants gone is rejected by a reviewer.
        if (proposal._rev_by === ctx.userId)
          return audit.refuse(collectionName, "self_approval_denied", { grantId: grant.id });

        const table = `${schema}.${ident(collectionName)}`;
        await client.query(`update ${table} set _rev_status = 'rejected' where _rev = $1`, [
          proposalId,
        ]);

        const c = findCollection(cfg, collectionName);
        const pk = c ? pkOf(c) : null;
        const docId = pk ? String(proposal[pk]) : String(proposal.id ?? proposal.document_id);
        await writeChangeLog(
          client,
          ctx,
          collectionName,
          docId,
          proposalId,
          proposal._rev_op,
          "rejected",
        );

        const rec = await audit.allow(collectionName, { grantId: grant.id });
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
    const audit = makeAuditWriter(app, ctx, d.auditEnabled);
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
      const proposals = await withOrg(pool, ctx.orgId, async (client) => {
        const out: ProposalSummary[] = [];
        for (const name of names) {
          const c = findCollection(cfg, name);
          // Only revisable collections have proposals at all.
          if (!c || !c.writable || c.type === "file") continue;

          // Fresh per collection, like every other grant check. No approve verb → this
          // collection is simply absent from the feed, not a refusal: a reviewer learning
          // which collections they cannot approve for is itself a disclosure.
          const grant = await loadActiveGrant(app, ctx, name);
          if (!grant || !grant.verbs.includes("approve")) continue;
          // A grant whose filters cannot be evaluated contributes nothing, for the same reason a
          // grant without `approve` does. matchesFilters would already drop every row; skipping
          // here says so outright and spares the query.
          if (validateDocumentFilters(grant.documentFilter, c)) continue;

          // Bookkeeping columns only, plus the document-filter field when one is set. Selecting
          // `*` would pull ungranted values into memory even if they were never returned, and
          // "denied means absent" means never fetched, not filtered afterwards.
          const pk = pkOf(c);
          const cols = ["_rev", "_rev_op", "_rev_fields", "_rev_by", "_rev_at"];
          if (pk) cols.push(pk);
          for (const f of grant.documentFilter)
            if (Object.hasOwn(c.fields, f.field) && !cols.includes(f.field)) cols.push(f.field);

          const q = await client.query(
            `select ${cols.map(ident).join(", ")} from ${schema}.${ident(name)}
             where _rev_status = $1 order by _rev_at`,
            [storedStatus],
          );

          for (const row of q.rows) {
            if (!matchesFilters(row, grant.documentFilter, c)) continue;
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
        fieldsReturned: string[];
        auditId: AuditId;
      }
    | { ok: false; reason: RefusalReason; auditId: AuditId }
  > {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled);
    const pool = writePool(pools, ctx);
    if (!pool) return audit.refuse("*", "internal_error");

    const schema = dataSchema(ctx.env);

    try {
      const found = await withOrg(pool, ctx.orgId, (client) =>
        findPending(client, schema, proposalId),
      );

      if (!found) return audit.refuse("*", "not_found");
      const { collection: coll, row } = found;

      const c = findCollection(cfg, coll);
      if (!c) return audit.refuse(coll, "unknown_collection");

      const grant = await loadActiveGrant(app, ctx, coll);
      // Approving is the act this read exists to inform, so it is gated on `approve`, not
      // merely `read` — matching approveProposal's own requirement.
      if (!grant || !grant.verbs.includes("read") || !grant.verbs.includes("approve"))
        return audit.refuse(coll, "no_grant", { grantId: grant?.id ?? null });

      // As in query and mutate: an unevaluable filter is the grant's problem, reported the same
      // way everywhere rather than as a missing document.
      if (validateDocumentFilters(grant.documentFilter, c))
        return audit.refuse(coll, "invalid_intent", { grantId: grant.id });

      if (!matchesFilters(row, grant.documentFilter, c))
        return audit.refuse(coll, "not_found", { grantId: grant.id });

      const pk = pkOf(c);
      if (!pk) return audit.refuse(coll, "invalid_intent", { grantId: grant.id });

      // Same rule as every other read: a field is visible only if the grant carries it.
      const readable = grant.allowedFields.filter((f) => Object.hasOwn(c.fields, f));
      const values: Document = {};
      for (const f of readable) values[f] = row[f];

      const rec = await audit.allow(coll, { fieldsReturned: readable, grantId: grant.id });
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
        fieldsReturned: readable,
        auditId: rec.auditId,
      };
    } catch (err) {
      console.error("[broker] getProposal failed", { proposalId, err });
      return audit.refuse("*", "internal_error");
    }
  }

  return { approveProposal, rejectProposal, listProposals, getProposal };
}
