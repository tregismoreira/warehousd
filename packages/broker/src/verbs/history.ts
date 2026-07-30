import type { PoolClient } from "pg";
import type { BrokerContext, RefusalReason, AuditId } from "../types";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../types";
import type { ActiveGrant } from "../grants/eval";
import { loadActiveGrant } from "../grants/eval";
import { matchesFilters, validateDocumentFilters } from "../grants/filters";
import { dataPool, withOrg, writePool } from "../db/pools";
import { findCollection } from "../config/load";
import { pkOf, dataSchema } from "../config/collection";
import { ident } from "../sql/ident";
import { makeAuditWriter } from "../audit/decision";
import type { VerbDeps } from "./deps";

export type ChangeEntry = {
  seq: number; collection: string; documentId: string; rev: string;
  op: string; status: string; at: string; by: string;
};

export type RevisionMetadata = {
  rev: string; seq: number; at: string; by: string; op: string; status: string; fields: string[];
};

export function makeHistoryVerbs(d: VerbDeps) {
  const { app, cfg, pools } = d;

  async function changes(
    ctx: BrokerContext,
    opts: { since?: number; limit?: number } = {},
  ): Promise<
    | { ok: true; entries: ChangeEntry[]; auditId: string }
    | { ok: false; reason: RefusalReason; auditId: AuditId }
  > {
    const audit = makeAuditWriter(app, ctx);
    const since = opts.since ?? 0;
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    try {
      // Load all grants to filter collections; caller sees only collections they can read
      const collections = Object.keys(cfg.collections);
      const grantsByCollection = new Map<string, ActiveGrant | null>();
      for (const c of collections) {
        const grant = await loadActiveGrant(app, ctx, c);
        // No grant or no read verb → no entries for this collection
        if (grant && grant.verbs.includes("read")) grantsByCollection.set(c, grant);
      }

      // `seq` order is not commit order. bigserial hands out numbers when a statement runs,
      // not when its transaction commits, so a writer can take seq 7 and commit *after* a
      // writer holding seq 8. A reader that polls in between would see 8, advance its cursor
      // past 7, and lose that entry forever — a silently lossy feed.
      //
      // So hold back anything an in-flight transaction could still be sitting on: only return
      // rows whose inserting transaction is older than the oldest one currently running.
      // `xmin` is the row's inserting xid; pg_snapshot_xmin is the watermark below which every
      // transaction has finished. Once a row passes this test, no lower `seq` can appear later.
      // The alternative — a fixed time delay — is both laggy and still wrong for any
      // transaction that outlives the delay.
      const entries = await withOrg(dataPool(pools, ctx), ctx.orgId, async (client: PoolClient) => {
        const q = await client.query(
          `select seq, collection, document_id, rev, op, status, at, by
           from app.change_log
           where org_id = $1 and env = $2 and seq > $3
             and xmin::text::bigint < pg_snapshot_xmin(pg_current_snapshot())::text::bigint
           order by seq asc limit $4`,
          [ctx.orgId, ctx.env, since, limit],
        );
        return q.rows;
      });

      // Grant-filtered by collection only. A grant's document_filter is NOT applied: the feed
      // carries no field data, so there is nothing here to test a field predicate against. The
      // consequence is deliberate and bounded — a caller with a document-filtered grant learns
      // that *some* document in that collection changed, and its id, but not which fields moved
      // or what they now hold. getDocument then refuses the ones outside the filter. Stated in
      // docs/architecture.md rather than left to be discovered.
      const filtered = entries.filter((e) => grantsByCollection.has(e.collection));

      const rec = await audit.allow("*");
      if (!rec.ok) return rec;

      return {
        ok: true as const,
        entries: filtered.map((e) => ({
          seq: Number(e.seq),
          collection: e.collection,
          documentId: e.document_id,
          rev: String(e.rev),
          op: e.op,
          status: e.status,
          at: new Date(e.at).toISOString(),
          by: e.by,
        })),
        auditId: rec.auditId,
      };
    } catch (err) {
      console.error("[broker] changes failed", { err });
      return audit.refuse("*", "internal_error");
    }
  }

  async function listRevisions(
    ctx: BrokerContext, opts: { collection: string; id: string },
  ): Promise<
    { ok: true; revisions: RevisionMetadata[]; auditId: string }
    | { ok: false; reason: RefusalReason; auditId: AuditId }
  > {
    const audit = makeAuditWriter(app, ctx);
    const name = opts.collection;
    const c = findCollection(cfg, name);
    if (!c) return audit.refuse(name, "unknown_collection");
    if (!c.writable) return audit.refuse(name, "invalid_intent");

    const pool = writePool(pools, ctx);
    if (!pool) return audit.refuse(name, "internal_error");

    const grant = await loadActiveGrant(app, ctx, name);
    if (!grant) return audit.refuse(name, "no_grant");
    if (!grant.verbs.includes("read")) return audit.refuse(name, "no_grant");

    if (validateDocumentFilters(grant.documentFilter, c))
      return audit.refuse(name, "invalid_intent", { grantId: grant.id });

    const schema = dataSchema(ctx.env);
    const pk = pkOf(c);
    if (!pk) return audit.refuse(name, "invalid_intent", { grantId: grant.id });

    const cols = ["_rev", "_rev_seq", "_rev_at", "_rev_by", "_rev_op", "_rev_status", "_rev_fields"];
    for (const f of grant.documentFilter)
      if (Object.hasOwn(c.fields, f.field) && !cols.includes(f.field)) cols.push(f.field);

    try {
      const revisions = await withOrg(pool, ctx.orgId, async (client) => {
        // Fetch current row to apply document filter against
        const currentQ = await client.query(
          `select ${cols.map(ident).join(", ")} from ${schema}.${ident(name)}
           where org_id=$1 and ${ident(pk)}=$2 and _current`, [ctx.orgId, opts.id]);

        if (currentQ.rows.length === 0) {
          return null; // Document not found or filtered out
        }
        const currentRow = currentQ.rows[0];
        if (!matchesFilters(currentRow, grant.documentFilter, c)) {
          return null; // Document filtered out
        }

        // Every revision of this document, in the order the document held them.
        //
        // `superseded` rows are excluded: they are pending revisions an approval merged into a new
        // one, so they record what was proposed rather than a state the document was ever in.
        // Including them showed each approval twice — and with the same `_rev_seq` as the revision
        // that replaced them, so `order by _rev_seq` could not even put the pair in a stable order.
        const q = await client.query(
          `select ${cols.map(ident).join(", ")} from ${schema}.${ident(name)}
           where org_id=$1 and ${ident(pk)}=$2 and _rev_status <> 'superseded'
           order by _rev_seq asc`, [ctx.orgId, opts.id]);

        return q.rows.map((row) => ({
          rev: String(row._rev),
          seq: Number(row._rev_seq),
          at: new Date(row._rev_at).toISOString(),
          by: String(row._rev_by),
          op: String(row._rev_op),
          status: String(row._rev_status),
          fields: row._rev_fields ?? [],
        }));
      });

      if (!revisions) return audit.refuse(name, "not_found", { grantId: grant.id });

      const rec = await audit.allow(name, { grantId: grant.id });
      if (!rec.ok) return rec;
      return { ok: true, revisions, auditId: rec.auditId };
    } catch (err) {
      console.error("[broker] listRevisions failed", { collection: name, id: opts.id, err });
      return audit.refuse(name, "internal_error", { grantId: grant.id });
    }
  }

  return { changes, listRevisions };
}

// Write a change log entry in the same transaction as the revision. Must be called inside
// withOrg on the write pool. This binds the feed to revisions: if the tx rolls back,
// so does the feed entry, keeping them consistent.
export async function writeChangeLog(
  client: PoolClient,
  ctx: BrokerContext,
  collection: string,
  documentId: string,
  rev: string,
  op: string,
  status: string,
): Promise<void> {
  await client.query(
    `insert into app.change_log (org_id, env, collection, document_id, rev, op, status, by) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ctx.orgId, ctx.env, collection, documentId, rev, op, status, ctx.userId],
  );
}
