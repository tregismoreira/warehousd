import type { PoolClient } from "pg";
import type {
  BrokerContext, QueryIntent, DocSearchIntent, BrokerResult, VisibleSchema, Refusal,
  GetDocumentIntent, GetDocumentResult, Document, Filter,
} from "../types";
import { MAX_LIMIT } from "../types";
import { loadActiveGrant } from "../grants/eval";
import { validateDocumentFilters } from "../grants/filters";
import { buildSelect, UnsupportedFilter } from "../sql/build";
import { ident } from "../sql/ident";
import { dataPool, withOrg, writePool } from "../db/pools";
import { findCollection } from "../config/load";
import { pkOf, dataSchema } from "../config/collection";
import { reassembleChunks } from "../indexing/chunk";
import { makeAuditWriter } from "../audit/decision";
import {
  QueryIntentSchema, DocSearchIntentSchema, GetDocumentIntentSchema, checkIntent,
} from "../intents/schema";
import type { VerbDeps } from "./deps";

export function makeReadVerbs(d: VerbDeps) {
  const { app, cfg, pools, isMultiValueField } = d;

  async function query(ctx: BrokerContext, raw: QueryIntent): Promise<BrokerResult> {
    const audit = makeAuditWriter(app, ctx);
    // 0. intent shape at runtime, before anything reads it
    const parsed = checkIntent(QueryIntentSchema, raw, "query");
    if (!parsed.ok) return audit.refuse(parsed.collection, "invalid_intent");
    const intent = parsed.intent;
    // 1. intent shape
    if (intent.aggregate && intent.aggregate.length && intent.fields && intent.fields.length)
      return audit.refuse(intent.collection, "invalid_intent", { intent });
    // 2. collection exists
    const c = findCollection(cfg, intent.collection);
    if (!c) return audit.refuse(intent.collection, "unknown_collection", { intent });
    const all = Object.keys(c.fields);
    // every referenced field must exist on the collection at all
    const referenced = collectReferenced(intent);
    for (const f of referenced) if (!all.includes(f))
      return audit.refuse(intent.collection, "unknown_field", { intent });
    // 3. active grant
    const grant = await loadActiveGrant(app, ctx, intent.collection);
    if (!grant) return audit.refuse(intent.collection, "no_grant", { intent });
    // No read verb → no_grant (not a new code; §4 comment on information leak)
    if (!grant.verbs.includes("read")) return audit.refuse(intent.collection, "no_grant", { intent });
    // 4. every referenced field ∈ grant.allowedFields
    for (const f of referenced) if (!grant.allowedFields.includes(f))
      return audit.refuse(intent.collection, "field_denied", { intent, grantId: grant.id });
    // document_filter is grant-author-supplied; each predicate's field is validated against
    // the collection's full YAML field set (NOT allowedFields) so denied fields like `path` can
    // gate documents. The same check runs on the write path, so a filter this rejects is rejected
    // everywhere rather than being evaluated by one path and not the other — see grants/filters.ts.
    if (validateDocumentFilters(grant.documentFilter, c))
      return audit.refuse(intent.collection, "invalid_intent", { intent, grantId: grant.id });
    // fields to select: explicit, else all granted fields present on the collection
    const selectFields = intent.fields && intent.fields.length
      ? intent.fields
      : grant.allowedFields.filter((f) => all.includes(f));
    // 5. build + execute on the env-scoped pool through withOrg transaction
    try {
      const { text, values } = buildSelect(ctx.env, intent, grant.allowedFields,
        { documentFilters: grant.documentFilter, isMultiValueField });
      const documents = await withOrg(dataPool(pools, ctx), ctx.orgId, async (client: PoolClient) => {
        return (await client.query(text, values)).rows;
      });
      const fieldsReturned = intent.aggregate && intent.aggregate.length
        ? [...(intent.groupBy ?? []), ...intent.aggregate.map((a) => `${a.fn}_${a.field}`)]
        : selectFields;
      const rec = await audit.allow(intent.collection, { intent, fieldsReturned, grantId: grant.id });
      if (!rec.ok) return rec;
      return { ok: true, documents, fieldsReturned, auditId: rec.auditId };
    } catch (err) {
      // A filter the builder can't express is the caller's mistake, not ours. It carries no
      // driver detail, so answering invalid_intent tells them something actionable.
      if (err instanceof UnsupportedFilter)
        return audit.refuse(intent.collection, "invalid_intent", { intent, grantId: grant.id });
      // Never surface a raw driver error: Postgres messages name columns, tables and
      // values, which is exactly what §10 test 4 forbids leaking. The audit row is
      // the non-negotiable part — an unaudited probe leaves no trace.
      console.error("[broker] query failed", { collection: intent.collection, err });
      return audit.refuse(intent.collection, "internal_error", { intent, grantId: grant.id });
    }
  }

  async function describeCollection(ctx: BrokerContext, name: string): Promise<VisibleSchema | Refusal> {
    const audit = makeAuditWriter(app, ctx);
    const c = findCollection(cfg, name);
    if (!c) return audit.refuse(name, "unknown_collection");
    const grant = await loadActiveGrant(app, ctx, name);
    if (!grant) return audit.refuse(name, "no_grant");
    if (!grant.verbs.includes("read")) return audit.refuse(name, "no_grant");
    const fields = Object.entries(c.fields)
      .filter(([n]) => grant.allowedFields.includes(n))
      // type is guaranteed by CollectionSchema refinement for structured collections; file collections have types filled in by transform
      // A multi-value term field is pinned to `text` in config so the schema stays simple, but
      // the column is text[]. Report what the caller will actually be querying, or they write a
      // scalar filter against an array and get a refusal they can't diagnose.
      .map(([n, f]) => ({ name: n, type: isMultiValueField(n) ? "text[]" : f.type!, pk: f.pk }));
    const rec = await audit.allow(name, { fieldsReturned: fields.map((f) => f.name), grantId: grant.id });
    if (!rec.ok) return rec;
    return { collection: name, description: c.description, fields };
  }

  // Returns the listing, or a Refusal on the one path that can fail: the audit write. Discovery
  // is audited like every other decision, and an unrecorded decision hands back nothing — the
  // same rule the other verbs follow, which is why this is not a bare array.
  async function listCollections(
    ctx: BrokerContext,
  ): Promise<{ name: string; description: string }[] | Refusal> {
    const audit = makeAuditWriter(app, ctx);
    // The client's collection ceiling applies to discovery too. loadActiveGrant enforces it on
    // every other verb, so without this a restricted client could enumerate names and
    // descriptions for collections no grant it holds can ever reach — a catalogue of what it is
    // not allowed to ask about. Names and descriptions *within* the ceiling stay visible to any
    // authenticated caller by design: that is what makes `request_access` usable.
    // `null`/absent means no ceiling, matching grants/eval.ts.
    const ceiling = ctx.allowedCollections;
    const collections = Object.entries(cfg.collections)
      .filter(([name]) => ceiling == null || ceiling.includes(name))
      .map(([name, c]) => ({ name, description: c.description }));
    const rec = await audit.allow("*");
    if (!rec.ok) return rec;
    return collections;
  }

  async function searchDocuments(ctx: BrokerContext, raw: DocSearchIntent): Promise<BrokerResult> {
    const audit = makeAuditWriter(app, ctx);
    const parsed = checkIntent(DocSearchIntentSchema, raw, "searchDocuments");
    if (!parsed.ok) return audit.refuse(parsed.collection, "invalid_intent");
    const intent = parsed.intent;
    const c = findCollection(cfg, intent.collection);
    if (!c) return audit.refuse(intent.collection, "unknown_collection", { intent });
    if (typeof intent.q !== "string" || !intent.q.trim())
      return audit.refuse(intent.collection, "invalid_intent", { intent });

    // Check if searchable: file collections always support search (via tsv column);
    // dataset collections need at least one searchable: true field
    const isFile = c.type === "file";
    const searchableFields = isFile ? [] : Object.entries(c.fields)
      .filter(([, f]) => f.searchable === true).map(([n]) => n);
    if (!isFile && searchableFields.length === 0)
      return audit.refuse(intent.collection, "invalid_intent", { intent });

    const all = Object.keys(c.fields);
    for (const f of intent.fields ?? []) if (!all.includes(f))
      return audit.refuse(intent.collection, "unknown_field", { intent });
    const grant = await loadActiveGrant(app, ctx, intent.collection);
    if (!grant) return audit.refuse(intent.collection, "no_grant", { intent });
    if (!grant.verbs.includes("read")) return audit.refuse(intent.collection, "no_grant", { intent });
    for (const f of intent.fields ?? []) if (!grant.allowedFields.includes(f))
      return audit.refuse(intent.collection, "field_denied", { intent, grantId: grant.id });
    if (validateDocumentFilters(grant.documentFilter, c))
      return audit.refuse(intent.collection, "invalid_intent", { intent, grantId: grant.id });
    const selectFields = intent.fields && intent.fields.length
      ? intent.fields : grant.allowedFields.filter((f) => all.includes(f));
    try {
      const { text, values } = buildSelect(ctx.env,
        { collection: intent.collection, fields: selectFields, limit: intent.limit, offset: intent.offset } as QueryIntent,
        grant.allowedFields,
        { q: intent.q, documentFilters: grant.documentFilter, isMultiValueField,
          searchFields: searchableFields });
      const documents = await withOrg(dataPool(pools, ctx), ctx.orgId, async (client: PoolClient) => {
        return (await client.query(text, values)).rows;
      });
      const rec = await audit.allow(intent.collection,
        { intent, fieldsReturned: selectFields, grantId: grant.id });
      if (!rec.ok) return rec;
      return { ok: true, documents, fieldsReturned: selectFields, auditId: rec.auditId };
    } catch (err) {
      // Never surface a raw driver error: Postgres messages name columns, tables and
      // values, which is exactly what §10 test 4 forbids leaking. The audit row is
      // the non-negotiable part — an unaudited probe leaves no trace.
      console.error("[broker] searchDocuments failed", { collection: intent.collection, err });
      return audit.refuse(intent.collection, "internal_error", { intent, grantId: grant.id });
    }
  }

  // The full-document read. It shares query's prologue deliberately — same grant, same read
  // verb, same field postures, same document filter — and differs only in how the target is
  // addressed and, for file collections, in reassembling the chunks back into one document.
  async function getDocument(ctx: BrokerContext, raw: GetDocumentIntent): Promise<GetDocumentResult> {
    const audit = makeAuditWriter(app, ctx);
    const parsed = checkIntent(GetDocumentIntentSchema, raw, "getDocument");
    if (!parsed.ok) return audit.refuse(parsed.collection, "invalid_intent");
    const intent = parsed.intent;
    const c = findCollection(cfg, intent.collection);
    if (!c) return audit.refuse(intent.collection, "unknown_collection");
    const isFile = c.type === "file";
    const byPath = "path" in intent;
    // A path addresses a source file; a dataset has none.
    if (byPath && !isFile) return audit.refuse(intent.collection, "invalid_intent");

    const grant = await loadActiveGrant(app, ctx, intent.collection);
    if (!grant) return audit.refuse(intent.collection, "no_grant");
    if (!grant.verbs.includes("read")) return audit.refuse(intent.collection, "no_grant");

    const all = Object.keys(c.fields);
    if (validateDocumentFilters(grant.documentFilter, c))
      return audit.refuse(intent.collection, "invalid_intent", { grantId: grant.id });

    // How the caller names the document. Like documentFilter this is broker-supplied rather
    // than client-supplied, so it may reference a column outside allowedFields — a file's
    // `path` is commonly posture:deny yet is exactly how you address the file.
    let key: Filter;
    if (isFile) {
      key = byPath
        ? { field: "path", op: "eq", value: (intent as { path: string }).path }
        : { field: "file_id", op: "eq", value: (intent as { id: string }).id };
    } else {
      const pk = pkOf(c);
      // Without a declared pk there is no document identity to address by id.
      if (!pk) return audit.refuse(intent.collection, "invalid_intent", { grantId: grant.id });
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
        { documentFilters: grant.documentFilter, isMultiValueField });
      const rows = await withOrg(dataPool(pools, ctx), ctx.orgId,
        async (client: PoolClient) => (await client.query(text, values)).rows);

      // Absent and excluded-by-filter are the same answer. Distinguishing them would make this
      // an existence oracle for documents the grant deliberately hides.
      if (rows.length === 0)
        return audit.refuse(intent.collection, "not_found", { grantId: grant.id });

      const document: Document = { ...rows[0] };
      if (isFile && selectFields.includes("content"))
        document.content = reassembleChunks(rows.map((r) => String(r.content ?? "")));

      // _rev only exists on writable collections (dataset type with revisions tracking).
      // Fetch it separately because it's a system field, not a granted field, and it's needed
      // for concurrency control (ETag/If-Match). It identifies the document's current state
      // for the caller, which is not a field-value disclosure — like MutationResult.rev.
      // Fetch through writePool (read role cannot see base tables, only views which exclude _rev).
      // Like listRevisions and listProposals, this gracefully degrades if no write pool exists.
      let rev: string | undefined;
      if (c.writable && !isFile) {
        const pool = writePool(pools, ctx);
        if (pool) {
          const pk = pkOf(c);
          if (pk) {
            const schema = dataSchema(ctx.env);
            const revQuery = await withOrg(pool, ctx.orgId,
              async (client: PoolClient) => {
                const r = await client.query(`select _rev from ${schema}.${ident(intent.collection)} where ${ident(pk)} = $1 and _current`, [(intent as { id: string }).id]);
                return r.rows[0]?._rev;
              });
            rev = revQuery;
          }
        }
      }

      const rec = await audit.allow(intent.collection,
        { fieldsReturned: selectFields, grantId: grant.id });
      if (!rec.ok) return rec;
      return { ok: true, document, fieldsReturned: selectFields, rev, auditId: rec.auditId };
    } catch (err) {
      // Same discipline as query: a driver error names columns and values, so it goes to the
      // log and the caller gets a bare reason code. The audit row is written either way.
      console.error("[broker] getDocument failed", { collection: intent.collection, err });
      return audit.refuse(intent.collection, "internal_error", { grantId: grant.id });
    }
  }

  return { query, describeCollection, listCollections, searchDocuments, getDocument };
}

// Every field named anywhere in the intent (fields, filters, orderBy, aggregate, groupBy).
export function collectReferenced(intent: QueryIntent): string[] {
  const s = new Set<string>();
  (intent.fields ?? []).forEach((f) => s.add(f));
  (intent.filters ?? []).forEach((f) => s.add(f.field));
  if (intent.orderBy) s.add(intent.orderBy.field);
  (intent.aggregate ?? []).forEach((a) => s.add(a.field));
  (intent.groupBy ?? []).forEach((f) => s.add(f));
  return [...s];
}
