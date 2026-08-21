import type { Pool, PoolClient } from "pg";
import type { BrokerContext, RefusalReason, AuditId } from "../types";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../types";
import type { ActiveGrant } from "../grants/eval";
import { loadActiveGrant, loadActiveGrants } from "../grants/eval";
import { admits, validateDocumentFilters } from "../grants/filters";
import { dataPool, withWorkspace, writePool } from "../db/pools";
import { findCollection } from "../config/load";
import type { CollectionConfig } from "../config/schema";
import { pkOf, dataSchema, dataColsOf } from "../config/collection";
import { ident } from "../sql/ident";
import { aclColumnSql } from "../acl/sql";
import { makeAuditWriter } from "../audit/decision";
import { maskPlan, type GrantVerb } from "./guard";
import { maskExpr } from "../sql/mask";
import type { VerbDeps } from "./deps";

export type ChangeEntry = {
  seq: number;
  collection: string;
  documentId: string;
  rev: string;
  op: string;
  status: string;
  at: string;
  by: string;
};

export type RevisionMetadata = {
  rev: string;
  seq: number;
  at: string;
  by: string;
  op: string;
  status: string;
  fields: string[];
};

export type RevisionDocument = {
  rev: string;
  seq: number;
  at: string;
  by: string;
  op: string;
  status: string;
  document: Record<string, unknown>;
};

export type GetRevisionResult =
  | { ok: true; revision: RevisionDocument; fieldsReturned: string[]; auditId: AuditId }
  | { ok: false; reason: RefusalReason; auditId: AuditId };

export type FieldChange = { field: string; before: unknown; after: unknown };

export type DiffRevisionsResult =
  | {
      ok: true;
      from: string;
      to: string;
      changes: FieldChange[];
      fieldsReturned: string[];
      auditId: AuditId;
    }
  | { ok: false; reason: RefusalReason; auditId: AuditId };

// The prologue every history read — and revert.ts's own read of history — shares, in the order
// openHistory has always run it. Kept as one function, at module scope, so no second copy of a
// collection/grant/verb/document-filter ladder can drift into answering "why can't I see this?"
// differently. `verbs` is the parameter that lets revert.ts reuse this rather than fork it: the
// read verbs ask for `["read"]` alone, revert asks for `["read", "update"]` because a revert both
// reads history and writes.
//
// Two overloads carry the same rule guard.ts's `resolveGranted` states for the same reason: a
// caller that only ever asks for `["read"]` can never receive `verb_denied` — a missing `read` is
// always `no_grant` (see the loop below) — so its refusal reason stays `RefusalReason`, matching
// what the read verbs already return. A caller that asks for more than `read` (only revert.ts,
// today) gets the wider `RefusalReason | "verb_denied"`.
export type HistoryGrantOutcome<R extends string = RefusalReason> =
  | {
      ok: true;
      c: CollectionConfig;
      grant: ActiveGrant;
      pool: Pool;
      pk: string;
      schema: "data_live" | "data_synth";
    }
  // `grant` travels with the failure so a mutation-shaped caller can attach it to its own audit
  // call. It is null on every refusal reached before a grant was loaded, and — matching the rule
  // above — also null when the refusal IS `no_grant`: a caller cannot infer a grant exists from a
  // refusal that says otherwise. It is present only for `verb_denied` and the two `invalid_intent`
  // checks that run after the grant is in hand.
  | { ok: false; reason: R; grant: ActiveGrant | null };

export function resolveHistoryGrant(
  d: VerbDeps,
  ctx: BrokerContext,
  name: string,
  verbs: readonly ["read"],
): Promise<HistoryGrantOutcome>;
export function resolveHistoryGrant(
  d: VerbDeps,
  ctx: BrokerContext,
  name: string,
  verbs: readonly GrantVerb[],
): Promise<HistoryGrantOutcome<RefusalReason | "verb_denied">>;
export async function resolveHistoryGrant(
  d: VerbDeps,
  ctx: BrokerContext,
  name: string,
  verbs: readonly GrantVerb[],
): Promise<HistoryGrantOutcome<RefusalReason | "verb_denied">> {
  const { app, cfg, pools } = d;

  const c = findCollection(cfg, name);
  if (!c) return { ok: false, reason: "unknown_collection", grant: null };
  if (!c.writable) return { ok: false, reason: "invalid_intent", grant: null };

  const pool = writePool(pools, ctx);
  if (!pool) return { ok: false, reason: "internal_error", grant: null };

  const grant = await loadActiveGrant(app, ctx, name);
  if (!grant) return { ok: false, reason: "no_grant", grant: null };

  // Rule 1 from guard.ts, restated per verb in the list rather than once: a missing `read` is
  // simply "you cannot see this collection", `no_grant`, with no grant attached — the grant's
  // existence is itself information a caller without read access should not get. A missing verb
  // that is not `read` denies with the grant attached, because the caller already knows the grant
  // exists: they are holding it.
  for (const v of verbs) {
    if (!grant.verbs.includes(v))
      return v === "read"
        ? { ok: false, reason: "no_grant", grant: null }
        : { ok: false, reason: "verb_denied", grant };
  }

  if (validateDocumentFilters(grant.documentFilter, c))
    return { ok: false, reason: "invalid_intent", grant };

  const pk = pkOf(c);
  if (!pk) return { ok: false, reason: "invalid_intent", grant };

  return { ok: true, c, grant, pool, pk, schema: dataSchema(ctx.env) };
}

// The current revision of one document, carrying its ACL, for the admits() check both reads run
// before returning anything, and that revert.ts's noop path now also runs. History (and a revert)
// is visible only for a document the grant's document filter and the document's ACL admit RIGHT
// NOW — not as of the revision. A document that became restricted must not stay readable through
// its own history, and must not stay revertible either.
export async function admitsDocument(
  client: PoolClient,
  ctx: BrokerContext,
  name: string,
  c: CollectionConfig,
  grant: ActiveGrant,
  pk: string,
  schema: string,
  id: string,
): Promise<boolean> {
  const cols = ["_rev"];
  for (const f of grant.documentFilter)
    if (Object.hasOwn(c.fields, f.field) && !cols.includes(f.field)) cols.push(f.field);
  const q = await client.query(
    `select ${cols.map((col) => `t.${ident(col)}`).join(", ")}${aclColumnSql(ctx.env, name, c, "t")}
       from ${schema}.${ident(name)} t
      where t.workspace_id=$1 and t.${ident(pk)}=$2 and t._current`,
    [ctx.workspaceId, id],
  );
  const row = q.rows[0];
  if (!row) return false;
  return admits(row, grant, c);
}

export function makeHistoryVerbs(d: VerbDeps) {
  const { app, cfg, pools } = d;

  async function changes(
    ctx: BrokerContext,
    opts: { since?: number | undefined; limit?: number | undefined } = {},
  ): Promise<
    | { ok: true; entries: ChangeEntry[]; auditId: AuditId }
    | { ok: false; reason: RefusalReason; auditId: AuditId }
  > {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo);
    const since = opts.since ?? 0;
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    try {
      // Load all grants to filter collections; caller sees only collections they can read
      const collections = Object.keys(cfg.collections);
      const grantsByCollection = new Map<string, ActiveGrant | null>();
      for (const [c, grant] of await loadActiveGrants(app, ctx, collections)) {
        // No grant or no read verb → no entries for this collection
        if (grant.verbs.includes("read")) grantsByCollection.set(c, grant);
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
      const entries = await withWorkspace(
        dataPool(pools, ctx),
        ctx.workspaceId,
        async (client: PoolClient) => {
          const q = await client.query(
            `select seq, collection, document_id, rev, op, status, at, by
           from app.change_log
           where workspace_id = $1 and env = $2 and seq > $3
             and xmin::text::bigint < pg_snapshot_xmin(pg_current_snapshot())::text::bigint
           order by seq asc limit $4`,
            [ctx.workspaceId, ctx.env, since, limit],
          );
          return q.rows;
        },
      );

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

  // Thin wrapper over the module-scope resolveHistoryGrant: the read verbs only ever need `read`,
  // and audit their refusal the query-shaped way (`audit.refuse`), unlike revert.ts's mutation
  // refusals. Returns a refusal to hand straight back, or everything the caller needs to build a
  // statement.
  async function openHistory(
    ctx: BrokerContext,
    audit: ReturnType<typeof makeAuditWriter>,
    name: string,
  ): Promise<
    | { ok: false; refusal: { ok: false; reason: RefusalReason; auditId: AuditId } }
    | {
        ok: true;
        c: CollectionConfig;
        grant: ActiveGrant;
        pool: Pool;
        pk: string;
        schema: "data_live" | "data_synth";
      }
  > {
    const r = await resolveHistoryGrant(d, ctx, name, ["read"]);
    if (!r.ok) {
      return {
        ok: false,
        refusal: await audit.refuse(name, r.reason, r.grant ? { grant: r.grant } : {}),
      };
    }
    return { ok: true, c: r.c, grant: r.grant, pool: r.pool, pk: r.pk, schema: r.schema };
  }

  async function listRevisions(
    ctx: BrokerContext,
    opts: { collection: string; id: string },
  ): Promise<
    | { ok: true; revisions: RevisionMetadata[]; auditId: AuditId }
    | { ok: false; reason: RefusalReason; auditId: AuditId }
  > {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo);
    const name = opts.collection;
    const opened = await openHistory(ctx, audit, name);
    if (!opened.ok) return opened.refusal;
    const { c, grant, pool, pk, schema } = opened;

    const cols = [
      "_rev",
      "_rev_seq",
      "_rev_at",
      "_rev_by",
      "_rev_op",
      "_rev_status",
      "_rev_fields",
    ];
    for (const f of grant.documentFilter)
      if (Object.hasOwn(c.fields, f.field) && !cols.includes(f.field)) cols.push(f.field);

    try {
      const revisions = await withWorkspace(pool, ctx.workspaceId, async (client) => {
        // Fetch current row, with its ACL, to apply the document filter and the ACL against
        const currentQ = await client.query(
          `select ${cols.map((col) => `t.${ident(col)}`).join(", ")}${aclColumnSql(ctx.env, name, c, "t")}
           from ${schema}.${ident(name)} t
           where t.workspace_id=$1 and t.${ident(pk)}=$2 and t._current`,
          [ctx.workspaceId, opts.id],
        );

        if (currentQ.rows.length === 0) {
          return null; // Document not found or filtered out
        }
        const currentRow = currentQ.rows[0];
        if (!admits(currentRow, grant, c)) {
          return null; // Excluded by the grant's document filter or by the document's ACL
        }

        // Every revision of this document, in the order the document held them.
        //
        // `superseded` rows are excluded: they are pending revisions an approval merged into a new
        // one, so they record what was proposed rather than a state the document was ever in.
        // Including them showed each approval twice — and with the same `_rev_seq` as the revision
        // that replaced them, so `order by _rev_seq` could not even put the pair in a stable order.
        const q = await client.query(
          `select ${cols.map(ident).join(", ")} from ${schema}.${ident(name)}
           where workspace_id=$1 and ${ident(pk)}=$2 and _rev_status <> 'superseded'
           order by _rev_seq asc`,
          [ctx.workspaceId, opts.id],
        );

        return q.rows.map((row) => ({
          rev: String(row._rev),
          seq: Number(row._rev_seq),
          at: new Date(row._rev_at).toISOString(),
          by: String(row._rev_by),
          op: String(row._rev_op),
          status: String(row._rev_status),
          // Filtered by the grant. `_rev_fields` is the raw list of columns a revision touched,
          // so returning it verbatim discloses the NAMES of fields the caller cannot read —
          // which is what "denied means absent" forbids, in a response the caller is otherwise
          // entitled to. A caller learns that a revision happened, and which of the fields they
          // can read moved; not that a field they cannot read exists.
          fields: (row._rev_fields ?? []).filter((f: string) => grant.allowedFields.includes(f)),
        }));
      });

      if (!revisions) return audit.refuse(name, "not_found", { grant });

      const rec = await audit.allow(name, { grant });
      if (!rec.ok) return rec;
      return { ok: true, revisions, auditId: rec.auditId };
    } catch (err) {
      console.error("[broker] listRevisions failed", { collection: name, id: opts.id, err });
      return audit.refuse(name, "internal_error", { grant });
    }
  }

  /**
   * One past revision of one document, projected through the caller's CURRENT grant and the
   * collection's CURRENT postures.
   *
   * Policy is read as of now, deliberately, not as of the revision. A field that was `allow` a
   * year ago and is `deny` today is absent here — the alternative is a config change that
   * silently fails to take effect on everything already written, which is the opposite of what
   * changing a posture is for.
   *
   * Masking happens in the statement, through the same maskExpr the read path uses, so a masked
   * field's raw value is never fetched. A diff of a masked field therefore reads as unchanged
   * even when it moved; that is correct, and it is stated in docs/architecture.md.
   */
  async function getRevision(
    ctx: BrokerContext,
    opts: { collection: string; id: string; rev: string },
  ): Promise<GetRevisionResult> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo);
    const name = opts.collection;
    const opened = await openHistory(ctx, audit, name);
    if (!opened.ok) return opened.refusal;
    const { c, grant, pool, pk, schema } = opened;

    const plan = maskPlan(cfg, name, c, grant.unmaskedFields);
    // Stored fields only: a view_join or relation field has no column on the base table, and the
    // base table is what history lives in.
    const stored = new Set(dataColsOf(c));
    const fields = grant.allowedFields.filter((f) => stored.has(f));
    if (fields.length === 0) return audit.refuse(name, "field_denied", { grant });

    try {
      const found = await withWorkspace(pool, ctx.workspaceId, async (client) => {
        if (!(await admitsDocument(client, ctx, name, c, grant, pk, schema, opts.id))) return null;

        const values: unknown[] = [ctx.workspaceId, opts.id, opts.rev];
        const param = (v: unknown) => {
          values.push(v);
          return `$${values.length}`;
        };
        const cols = fields.map((f) => {
          const mask = plan.maskFor(f);
          return mask ? maskExpr(f, mask, param) : ident(f);
        });
        const q = await client.query(
          `select _rev, _rev_seq, _rev_at, _rev_by, _rev_op, _rev_status, ${cols.join(", ")}
             from ${schema}.${ident(name)}
            where workspace_id=$1 and ${ident(pk)}=$2 and _rev=$3
              and _rev_status <> 'superseded'`,
          values,
        );
        return q.rows[0] ?? null;
      });

      if (!found) return audit.refuse(name, "not_found", { grant });

      const document: Record<string, unknown> = {};
      for (const f of fields) document[f] = found[f];

      const rec = await audit.allow(name, { grant, fieldsReturned: fields });
      if (!rec.ok) return rec;
      return {
        ok: true,
        revision: {
          rev: String(found._rev),
          seq: Number(found._rev_seq),
          at: new Date(found._rev_at).toISOString(),
          by: String(found._rev_by),
          op: String(found._rev_op),
          status: String(found._rev_status),
          document,
        },
        fieldsReturned: fields,
        auditId: rec.auditId,
      };
    } catch (err) {
      console.error("[broker] getRevision failed", { collection: name, id: opts.id, err });
      return audit.refuse(name, "internal_error", { grant });
    }
  }

  /**
   * The fields that moved between two revisions of one document.
   *
   * Both sides go through the same projection getRevision uses, so a denied field is absent
   * rather than reported as "changed, value withheld" — the NAME of a field a caller cannot read
   * is itself denied. A masked field is masked on both sides, which means a diff of one can read
   * as unchanged when it moved. That is the same trade the read path already makes: masked
   * fields cannot be filtered or ordered either, because a bisecting caller recovers the value.
   */
  async function diffRevisions(
    ctx: BrokerContext,
    opts: { collection: string; id: string; from: string; to: string },
  ): Promise<DiffRevisionsResult> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled, d.auditTo);
    const name = opts.collection;
    const opened = await openHistory(ctx, audit, name);
    if (!opened.ok) return opened.refusal;
    const { c, grant, pool, pk, schema } = opened;

    const plan = maskPlan(cfg, name, c, grant.unmaskedFields);
    const stored = new Set(dataColsOf(c));
    const fields = grant.allowedFields.filter((f) => stored.has(f));
    if (fields.length === 0) return audit.refuse(name, "field_denied", { grant });

    try {
      const rows = await withWorkspace(pool, ctx.workspaceId, async (client) => {
        if (!(await admitsDocument(client, ctx, name, c, grant, pk, schema, opts.id))) return null;

        const values: unknown[] = [ctx.workspaceId, opts.id, opts.from, opts.to];
        const param = (v: unknown) => {
          values.push(v);
          return `$${values.length}`;
        };
        const cols = fields.map((f) => {
          const mask = plan.maskFor(f);
          return mask ? maskExpr(f, mask, param) : ident(f);
        });
        // Both revisions in one statement: two round trips could straddle a write, and a diff
        // whose two halves came from different moments is worse than no diff.
        const q = await client.query(
          `select _rev, ${cols.join(", ")} from ${schema}.${ident(name)}
            where workspace_id=$1 and ${ident(pk)}=$2 and _rev in ($3, $4)
              and _rev_status <> 'superseded'`,
          values,
        );
        return q.rows;
      });

      if (!rows) return audit.refuse(name, "not_found", { grant });

      const before = rows.find((r) => String(r._rev) === opts.from);
      const after = rows.find((r) => String(r._rev) === opts.to);
      // `from === to` is legal and returns no changes; either id being absent is not.
      if (!before || !after) return audit.refuse(name, "not_found", { grant });

      const fieldChanges: FieldChange[] = [];
      for (const f of fields) {
        const b = before[f];
        const a = after[f];
        // JSON comparison rather than ===, so a date and a numeric compare by value the same way
        // the response will render them.
        if (JSON.stringify(b ?? null) !== JSON.stringify(a ?? null))
          fieldChanges.push({ field: f, before: b, after: a });
      }

      const rec = await audit.allow(name, { grant, fieldsReturned: fields });
      if (!rec.ok) return rec;
      return {
        ok: true,
        from: opts.from,
        to: opts.to,
        changes: fieldChanges,
        fieldsReturned: fields,
        auditId: rec.auditId,
      };
    } catch (err) {
      console.error("[broker] diffRevisions failed", { collection: name, id: opts.id, err });
      return audit.refuse(name, "internal_error", { grant });
    }
  }

  return { changes, listRevisions, getRevision, diffRevisions };
}

// Write a change log entry in the same transaction as the revision. Must be called inside
// withWorkspace on the write pool. This binds the feed to revisions: if the tx rolls back,
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
    `insert into app.change_log (workspace_id, env, collection, document_id, rev, op, status, by) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ctx.workspaceId, ctx.env, collection, documentId, rev, op, status, ctx.userId],
  );
}
