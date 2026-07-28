import type { Pool, PoolClient } from "pg";
import type {
  BrokerContext, QueryIntent, DocSearchIntent, BrokerResult, RefusalReason, VisibleSchema, Refusal,
  GetDocumentIntent, GetDocumentResult, Document, Filter,
} from "./types";
import { MAX_LIMIT } from "./types";
import type { WarehousdConfig } from "./config/schema";
import type { Pools } from "./db/pools";
import { dataPool, withOrg } from "./db/pools";
import { loadActiveGrant } from "./grants/eval";
import { buildSelect } from "./sql/build";
import { writeAudit } from "./audit/write";
import { findCollection } from "./config/load";
import { reassembleChunks } from "./indexing/chunk";

export function makeBroker(pools: Pools, cfg: WarehousdConfig) {
  const app = pools.app;

  async function refuse(ctx: BrokerContext, collection: string, intent: QueryIntent | DocSearchIntent | null,
    reason: RefusalReason, grantId: string | null = null): Promise<Refusal> {
    const auditId = await writeAudit(app, {
      userId: ctx.userId, env: ctx.env, collection, orgId: ctx.orgId, intent,
      fieldsReturned: [], grantId, outcome: "refused", reason });
    return { ok: false, reason, auditId };
  }

  function fieldsOf(collection: string): string[] | null {
    const c = findCollection(cfg, collection);
    return c ? Object.keys(c.fields) : null;
  }

  async function query(ctx: BrokerContext, intent: QueryIntent): Promise<BrokerResult> {
    // 1. intent shape
    if (intent.aggregate && intent.aggregate.length && intent.fields && intent.fields.length)
      return refuse(ctx, intent.collection, intent, "invalid_intent");
    // 2. collection exists
    const all = fieldsOf(intent.collection);
    if (!all) return refuse(ctx, intent.collection, intent, "unknown_collection");
    // every referenced field must exist on the collection at all
    const referenced = collectReferenced(intent);
    for (const f of referenced) if (!all.includes(f))
      return refuse(ctx, intent.collection, intent, "unknown_field");
    // 3. active grant
    const grant = await loadActiveGrant(app, ctx.userId, intent.collection, ctx.env, ctx.orgId);
    if (!grant) return refuse(ctx, intent.collection, intent, "no_grant");
    // No read verb → no_grant (not a new code; §4 comment on information leak)
    if (!grant.verbs.includes("read")) return refuse(ctx, intent.collection, intent, "no_grant");
    // 4. every referenced field ∈ grant.allowedFields
    for (const f of referenced) if (!grant.allowedFields.includes(f))
      return refuse(ctx, intent.collection, intent, "field_denied", grant.id);
    // document_filter is grant-author-supplied; its field is validated against the collection's
    // full YAML field set (NOT allowedFields) so denied fields like `path` can gate documents.
    if (grant.documentFilter && !all.includes(grant.documentFilter.field))
      return refuse(ctx, intent.collection, intent, "invalid_intent", grant.id);
    // fields to select: explicit, else all granted fields present on the collection
    const selectFields = intent.fields && intent.fields.length
      ? intent.fields
      : grant.allowedFields.filter((f) => all.includes(f));
    // 5. build + execute on the env-scoped pool through withOrg transaction
    try {
      const { text, values } = buildSelect(ctx.env, intent, grant.allowedFields, { documentFilter: grant.documentFilter });
      const documents = await withOrg(dataPool(pools, ctx), ctx.orgId, async (client: PoolClient) => {
        return (await client.query(text, values)).rows;
      });
      const fieldsReturned = intent.aggregate && intent.aggregate.length
        ? [...(intent.groupBy ?? []), ...intent.aggregate.map((a) => `${a.fn}_${a.field}`)]
        : selectFields;
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: intent.collection, orgId: ctx.orgId, intent,
        fieldsReturned, grantId: grant.id, outcome: "allowed", reason: null });
      return { ok: true, documents, fieldsReturned, auditId };
    } catch (err) {
      // Never surface a raw driver error: Postgres messages name columns, tables and
      // values, which is exactly what §10 test 4 forbids leaking. The audit row is
      // the non-negotiable part — an unaudited probe leaves no trace.
      console.error("[broker] query failed", { collection: intent.collection, err });
      return refuse(ctx, intent.collection, intent, "internal_error", grant?.id ?? null);
    }
  }

  async function describeCollection(ctx: BrokerContext, name: string): Promise<VisibleSchema | Refusal> {
    const c = findCollection(cfg, name);
    if (!c) return refuse(ctx, name, null, "unknown_collection");
    const grant = await loadActiveGrant(app, ctx.userId, name, ctx.env, ctx.orgId);
    if (!grant) return refuse(ctx, name, null, "no_grant");
    if (!grant.verbs.includes("read")) return refuse(ctx, name, null, "no_grant");
    const fields = Object.entries(c.fields)
      .filter(([n]) => grant.allowedFields.includes(n))
      // type is guaranteed by CollectionSchema refinement for structured collections; file collections have types filled in by transform
      .map(([n, f]) => ({ name: n, type: f.type!, pk: f.pk }));
    await writeAudit(app, { userId: ctx.userId, env: ctx.env, collection: name, orgId: ctx.orgId, intent: null,
      fieldsReturned: fields.map((f) => f.name), grantId: grant.id, outcome: "allowed", reason: null });
    return { collection: name, description: c.description, fields };
  }

  async function listCollections(ctx: BrokerContext): Promise<{ name: string; description: string }[]> {
    const collections = Object.entries(cfg.collections).map(([name, c]) => ({ name, description: c.description }));
    await writeAudit(app, {
      userId: ctx.userId, env: ctx.env, collection: "*", orgId: ctx.orgId, intent: null,
      fieldsReturned: [], grantId: null, outcome: "allowed", reason: null });
    return collections;
  }

  async function searchDocuments(ctx: BrokerContext, intent: DocSearchIntent): Promise<BrokerResult> {
    const c = findCollection(cfg, intent.collection);
    if (!c) return refuse(ctx, intent.collection, intent, "unknown_collection");
    if (typeof intent.q !== "string" || !intent.q.trim())
      return refuse(ctx, intent.collection, intent, "invalid_intent");

    // Check if searchable: file collections always support search (via tsv column);
    // dataset collections need at least one searchable: true field
    const isFile = c.type === "file";
    const searchableFields = isFile ? [] : Object.entries(c.fields)
      .filter(([, f]) => f.searchable === true).map(([n]) => n);
    if (!isFile && searchableFields.length === 0)
      return refuse(ctx, intent.collection, intent, "invalid_intent");

    const all = Object.keys(c.fields);
    for (const f of intent.fields ?? []) if (!all.includes(f))
      return refuse(ctx, intent.collection, intent, "unknown_field");
    const grant = await loadActiveGrant(app, ctx.userId, intent.collection, ctx.env, ctx.orgId);
    if (!grant) return refuse(ctx, intent.collection, intent, "no_grant");
    if (!grant.verbs.includes("read")) return refuse(ctx, intent.collection, intent, "no_grant");
    for (const f of intent.fields ?? []) if (!grant.allowedFields.includes(f))
      return refuse(ctx, intent.collection, intent, "field_denied", grant.id);
    if (grant.documentFilter && !all.includes(grant.documentFilter.field))
      return refuse(ctx, intent.collection, intent, "invalid_intent", grant.id);
    const selectFields = intent.fields && intent.fields.length
      ? intent.fields : grant.allowedFields.filter((f) => all.includes(f));
    try {
      const { text, values } = buildSelect(ctx.env,
        { collection: intent.collection, fields: selectFields, limit: intent.limit, offset: intent.offset } as QueryIntent,
        grant.allowedFields,
        { q: intent.q, documentFilter: grant.documentFilter, searchFields: searchableFields });
      const documents = await withOrg(dataPool(pools, ctx), ctx.orgId, async (client: PoolClient) => {
        return (await client.query(text, values)).rows;
      });
      const auditId = await writeAudit(app, { userId: ctx.userId, env: ctx.env,
        collection: intent.collection, orgId: ctx.orgId, intent, fieldsReturned: selectFields,
        grantId: grant.id, outcome: "allowed", reason: null });
      return { ok: true, documents, fieldsReturned: selectFields, auditId };
    } catch (err) {
      // Never surface a raw driver error: Postgres messages name columns, tables and
      // values, which is exactly what §10 test 4 forbids leaking. The audit row is
      // the non-negotiable part — an unaudited probe leaves no trace.
      console.error("[broker] searchDocuments failed", { collection: intent.collection, err });
      return refuse(ctx, intent.collection, intent, "internal_error", grant.id);
    }
  }

  // The full-document read. It shares query's prologue deliberately — same grant, same read
  // verb, same field postures, same document filter — and differs only in how the target is
  // addressed and, for file collections, in reassembling the chunks back into one document.
  async function getDocument(ctx: BrokerContext, intent: GetDocumentIntent): Promise<GetDocumentResult> {
    const c = findCollection(cfg, intent.collection);
    if (!c) return refuse(ctx, intent.collection, null, "unknown_collection");
    const isFile = c.type === "file";
    const byPath = "path" in intent;
    // A path addresses a source file; a dataset has none.
    if (byPath && !isFile) return refuse(ctx, intent.collection, null, "invalid_intent");

    const grant = await loadActiveGrant(app, ctx.userId, intent.collection, ctx.env, ctx.orgId);
    if (!grant) return refuse(ctx, intent.collection, null, "no_grant");
    if (!grant.verbs.includes("read")) return refuse(ctx, intent.collection, null, "no_grant");

    const all = Object.keys(c.fields);
    if (grant.documentFilter && !all.includes(grant.documentFilter.field))
      return refuse(ctx, intent.collection, null, "invalid_intent", grant.id);

    // How the caller names the document. Like documentFilter this is broker-supplied rather
    // than client-supplied, so it may reference a column outside allowedFields — a file's
    // `path` is commonly posture:deny yet is exactly how you address the file.
    let key: Filter;
    if (isFile) {
      key = byPath
        ? { field: "path", op: "eq", value: (intent as { path: string }).path }
        : { field: "file_id", op: "eq", value: (intent as { id: string }).id };
    } else {
      const pk = Object.entries(c.fields).find(([, f]) => f.pk)?.[0];
      // Without a declared pk there is no document identity to address by id.
      if (!pk) return refuse(ctx, intent.collection, null, "invalid_intent", grant.id);
      key = { field: pk, op: "eq", value: (intent as { id: string }).id };
    }

    const selectFields = grant.allowedFields.filter((f) => all.includes(f));

    try {
      // One file yields many documents, so the file form fetches every chunk in order and
      // rejoins them. A dataset document is a single row.
      const shaped: QueryIntent = isFile
        ? { collection: intent.collection, fields: selectFields, filters: [key],
            orderBy: { field: "document_seq", dir: "asc" }, limit: MAX_LIMIT }
        : { collection: intent.collection, fields: selectFields, filters: [key], limit: 1 };

      const { text, values } = buildSelect(ctx.env, shaped, grant.allowedFields,
        { documentFilter: grant.documentFilter });
      const rows = await withOrg(dataPool(pools, ctx), ctx.orgId,
        async (client: PoolClient) => (await client.query(text, values)).rows);

      // Absent and excluded-by-filter are the same answer. Distinguishing them would make this
      // an existence oracle for documents the grant deliberately hides.
      if (rows.length === 0) {
        const auditId = await writeAudit(app, {
          userId: ctx.userId, env: ctx.env, collection: intent.collection, orgId: ctx.orgId,
          intent: null, fieldsReturned: [], grantId: grant.id, outcome: "refused", reason: "not_found" });
        return { ok: false, reason: "not_found", auditId };
      }

      const document: Document = { ...rows[0] };
      if (isFile && selectFields.includes("content"))
        document.content = reassembleChunks(rows.map((r) => String(r.content ?? "")));

      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: intent.collection, orgId: ctx.orgId,
        intent: null, fieldsReturned: selectFields, grantId: grant.id, outcome: "allowed", reason: null });
      return { ok: true, document, fieldsReturned: selectFields, auditId };
    } catch (err) {
      // Same discipline as query: a driver error names columns and values, so it goes to the
      // log and the caller gets a bare reason code. The audit row is written either way.
      console.error("[broker] getDocument failed", { collection: intent.collection, err });
      return refuse(ctx, intent.collection, null, "internal_error", grant.id);
    }
  }
  return { query, describeCollection, listCollections, searchDocuments, getDocument };
}

// Every field named anywhere in the intent (fields, filters, orderBy, aggregate, groupBy).
function collectReferenced(intent: QueryIntent): string[] {
  const s = new Set<string>();
  (intent.fields ?? []).forEach((f) => s.add(f));
  (intent.filters ?? []).forEach((f) => s.add(f.field));
  if (intent.orderBy) s.add(intent.orderBy.field);
  (intent.aggregate ?? []).forEach((a) => s.add(a.field));
  (intent.groupBy ?? []).forEach((f) => s.add(f));
  return [...s];
}
