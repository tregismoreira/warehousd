import type { PoolClient } from "pg";
import type {
  BrokerContext,
  QueryIntent,
  DocSearchIntent,
  BrokerResult,
  VisibleSchema,
  Refusal,
  GetDocumentIntent,
  GetDocumentResult,
  Document,
  Filter,
} from "../types";
import { MAX_LIMIT } from "../types";
import { loadActiveGrant } from "../grants/eval";
import { validateDocumentFilters } from "../grants/filters";
import { buildSelect, UnsupportedFilter } from "../sql/build";
import { ident } from "../sql/ident";
import { dataPool, withOrg, writePool } from "../db/pools";
import { findCollection, maskedFieldsFor } from "../config/load";
import type { MaskConfig, CollectionConfig } from "../config/schema";
import { pkOf, dataSchema } from "../config/collection";
import { reassembleChunks } from "../indexing/chunk";
import { makeAuditWriter } from "../audit/decision";
import {
  QueryIntentSchema,
  DocSearchIntentSchema,
  GetDocumentIntentSchema,
  checkIntent,
} from "../intents/schema";
import type { VerbDeps } from "./deps";

export function makeReadVerbs(d: VerbDeps) {
  const { app, cfg, pools, isMultiValueField } = d;

  async function query(ctx: BrokerContext, raw: QueryIntent): Promise<BrokerResult> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled);
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
    for (const f of referenced)
      if (!all.includes(f)) return audit.refuse(intent.collection, "unknown_field", { intent });
    // 3. active grant
    const grant = await loadActiveGrant(app, ctx, intent.collection);
    if (!grant) return audit.refuse(intent.collection, "no_grant", { intent });
    // No read verb → no_grant (not a new code; §4 comment on information leak)
    if (!grant.verbs.includes("read"))
      return audit.refuse(intent.collection, "no_grant", { intent });
    // 4. every referenced field ∈ grant.allowedFields
    for (const f of referenced)
      if (!grant.allowedFields.includes(f))
        return audit.refuse(intent.collection, "field_denied", { intent, grantId: grant.id });
    // document_filter is grant-author-supplied; each predicate's field is validated against
    // the collection's full YAML field set (NOT allowedFields) so denied fields like `path` can
    // gate documents. The same check runs on the write path, so a filter this rejects is rejected
    // everywhere rather than being evaluated by one path and not the other — see grants/filters.ts.
    if (validateDocumentFilters(grant.documentFilter, c))
      return audit.refuse(intent.collection, "invalid_intent", { intent, grantId: grant.id });
    // 4b. a masked field may be PROJECTED but never computed over — see collectComputed.
    // field_denied, not a new code: the caller does hold the field, just not in a form that
    // answers this question, and inventing a reason would say which fields are masked to
    // someone whose grant does not carry them.
    const plan = maskPlan(cfg, intent.collection, c, grant.unmaskedFields);
    for (const f of collectComputed(intent))
      if (plan.masked.has(f))
        return audit.refuse(intent.collection, "field_denied", { intent, grantId: grant.id });
    // fields to select: explicit, else all granted fields present on the collection
    const selectFields =
      intent.fields && intent.fields.length
        ? intent.fields
        : grant.allowedFields.filter((f) => all.includes(f));
    // 5. build + execute on the env-scoped pool through withOrg transaction
    try {
      const { text, values } = buildSelect(ctx.env, intent, grant.allowedFields, {
        documentFilters: grant.documentFilter,
        isMultiValueField,
        maskFor: plan.maskFor,
      });
      const documents = await withOrg(
        dataPool(pools, ctx),
        ctx.orgId,
        async (client: PoolClient) => {
          return (await client.query(text, values)).rows;
        },
      );
      const fieldsReturned =
        intent.aggregate && intent.aggregate.length
          ? [...(intent.groupBy ?? []), ...intent.aggregate.map((a) => `${a.fn}_${a.field}`)]
          : selectFields;
      const rec = await audit.allow(intent.collection, {
        intent,
        fieldsReturned,
        // Which of those came back raw. The compliance question a masked field creates is not
        // "who read it" but "who read it unmasked", and this is the only record that answers it.
        unmaskedFields: selectFields.filter((f) => grant.unmaskedFields.includes(f)),
        grantId: grant.id,
      });
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

  async function describeCollection(
    ctx: BrokerContext,
    name: string,
  ): Promise<VisibleSchema | Refusal> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled);
    const c = findCollection(cfg, name);
    if (!c) return audit.refuse(name, "unknown_collection");
    const grant = await loadActiveGrant(app, ctx, name);
    if (!grant) return audit.refuse(name, "no_grant");
    if (!grant.verbs.includes("read")) return audit.refuse(name, "no_grant");
    const plan = maskPlan(cfg, name, c, grant.unmaskedFields);
    const fields = Object.entries(c.fields)
      .filter(([n]) => grant.allowedFields.includes(n))
      // type is guaranteed by CollectionSchema refinement for structured collections; file collections have types filled in by transform
      // A multi-value term field is pinned to `text` in config so the schema stays simple, but
      // the column is text[]. Report what the caller will actually be querying, or they write a
      // scalar filter against an array and get a refusal they can't diagnose.
      //
      // `masked` is reported for the same reason: a caller that does not know a field is
      // transformed will filter on it, get field_denied, and have no way to tell that from a
      // field it was never granted. Saying so here is not a disclosure — it describes the shape
      // of what this caller already holds, not what anyone else can see.
      .map(([n, f]) => ({
        name: n,
        type: isMultiValueField(n) ? "text[]" : f.type!,
        pk: f.pk,
        ...(plan.masked.has(n) ? { masked: true as const } : {}),
      }));
    const rec = await audit.allow(name, {
      fieldsReturned: fields.map((f) => f.name),
      grantId: grant.id,
    });
    if (!rec.ok) return rec;
    return { collection: name, description: c.description, fields };
  }

  // Returns the listing, or a Refusal on the one path that can fail: the audit write. Discovery
  // is audited like every other decision, and an unrecorded decision hands back nothing — the
  // same rule the other verbs follow, which is why this is not a bare array.
  async function listCollections(
    ctx: BrokerContext,
  ): Promise<{ name: string; description: string }[] | Refusal> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled);
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
    const audit = makeAuditWriter(app, ctx, d.auditEnabled);
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

    // Vector modes need three things, and each missing one is the caller's to fix rather than
    // something to paper over by quietly running a text search instead: a caller who asked for
    // `semantic` and silently got `text` cannot tell, and would draw conclusions from a ranking
    // that is not the one they requested.
    const mode = intent.mode ?? "text";
    if (mode !== "text") {
      // Only a file collection has an embedding column — a dataset document is a row, and there
      // is nothing chunked to embed.
      if (!isFile) return audit.refuse(intent.collection, "invalid_intent", { intent });
      if (!d.embedder) return audit.refuse(intent.collection, "invalid_intent", { intent });
    }
    const searchableFields = isFile
      ? []
      : Object.entries(c.fields)
          .filter(([, f]) => f.searchable === true)
          .map(([n]) => n);
    if (!isFile && searchableFields.length === 0)
      return audit.refuse(intent.collection, "invalid_intent", { intent });

    const all = Object.keys(c.fields);
    for (const f of intent.fields ?? [])
      if (!all.includes(f)) return audit.refuse(intent.collection, "unknown_field", { intent });
    const grant = await loadActiveGrant(app, ctx, intent.collection);
    if (!grant) return audit.refuse(intent.collection, "no_grant", { intent });
    if (!grant.verbs.includes("read"))
      return audit.refuse(intent.collection, "no_grant", { intent });
    for (const f of intent.fields ?? [])
      if (!grant.allowedFields.includes(f))
        return audit.refuse(intent.collection, "field_denied", { intent, grantId: grant.id });
    if (validateDocumentFilters(grant.documentFilter, c))
      return audit.refuse(intent.collection, "invalid_intent", { intent, grantId: grant.id });
    const selectFields =
      intent.fields && intent.fields.length
        ? intent.fields
        : grant.allowedFields.filter((f) => all.includes(f));
    // A masked field is projected here like anywhere else. Search itself is unaffected: a
    // dataset's searchable fields cannot be masked (CollectionSchema refuses the combination,
    // because the generated <f>_tsv indexes the raw column), and a file collection matches on
    // `content`, which cannot be masked either.
    const plan = maskPlan(cfg, intent.collection, c, grant.unmaskedFields);
    try {
      // The query vector is derived HERE, from the caller's `q`, after their grant has been
      // loaded and checked. There is no path by which a caller supplies one: that would be an
      // oracle over the embedding space of documents their grant excludes.
      const qVector = mode === "text" ? undefined : (await d.embedder!.embed([intent.q]))[0];
      const { text, values } = buildSelect(
        ctx.env,
        {
          collection: intent.collection,
          fields: selectFields,
          limit: intent.limit,
          offset: intent.offset,
        },
        grant.allowedFields,
        {
          q: intent.q,
          documentFilters: grant.documentFilter,
          isMultiValueField,
          searchFields: searchableFields,
          maskFor: plan.maskFor,
          mode,
          ...(qVector ? { qVector } : {}),
        },
      );
      const documents = await withOrg(
        dataPool(pools, ctx),
        ctx.orgId,
        async (client: PoolClient) => {
          return (await client.query(text, values)).rows;
        },
      );
      const rec = await audit.allow(intent.collection, {
        intent,
        fieldsReturned: selectFields,
        grantId: grant.id,
      });
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
  async function getDocument(
    ctx: BrokerContext,
    raw: GetDocumentIntent,
  ): Promise<GetDocumentResult> {
    const audit = makeAuditWriter(app, ctx, d.auditEnabled);
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
    const plan = maskPlan(cfg, intent.collection, c, grant.unmaskedFields);

    try {
      // One file yields many documents, so the file form fetches every chunk in order and
      // rejoins them. A dataset document is a single row.
      const shaped: QueryIntent = isFile
        ? {
            collection: intent.collection,
            fields: selectFields,
            filters: [key],
            orderBy: { field: "document_seq", dir: "asc" },
            limit: MAX_LIMIT,
          }
        : { collection: intent.collection, fields: selectFields, filters: [key], limit: 1 };

      const { text, values } = buildSelect(ctx.env, shaped, grant.allowedFields, {
        documentFilters: grant.documentFilter,
        isMultiValueField,
        maskFor: plan.maskFor,
      });
      const rows = await withOrg(
        dataPool(pools, ctx),
        ctx.orgId,
        async (client: PoolClient) => (await client.query(text, values)).rows,
      );

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
            const revQuery = await withOrg(pool, ctx.orgId, async (client: PoolClient) => {
              const r = await client.query(
                `select _rev from ${schema}.${ident(intent.collection)} where ${ident(pk)} = $1 and _current`,
                [(intent as { id: string }).id],
              );
              return r.rows[0]?._rev;
            });
            rev = revQuery;
          }
        }
      }

      const rec = await audit.allow(intent.collection, {
        fieldsReturned: selectFields,
        unmaskedFields: selectFields.filter((f) => grant.unmaskedFields.includes(f)),
        grantId: grant.id,
      });
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

// The fields an intent COMPUTES over rather than merely projects: filters, ordering, aggregation
// and grouping. Everything in collectReferenced except `fields`.
//
// This split exists because masking is only sound for projection. A masked field the caller can
// still filter, order or aggregate on is not masked in any useful sense:
//
//   - `gt`/`lt` turn a bucketed salary into a binary search, ten queries to the exact figure;
//   - `like` walks a redacted name one character at a time;
//   - `orderBy` leaks the full ranking, which for a small collection is the values;
//   - `min`/`max` return the raw extremes outright, and `avg` of a masked column is a number
//     that looks masked and is not.
//
// So a masked field here is refused. Projection is the only thing a mask can survive.
export function collectComputed(intent: QueryIntent): string[] {
  const s = new Set<string>();
  (intent.filters ?? []).forEach((f) => s.add(f.field));
  if (intent.orderBy) s.add(intent.orderBy.field);
  (intent.aggregate ?? []).forEach((a) => s.add(a.field));
  (intent.groupBy ?? []).forEach((f) => s.add(f));
  return [...s];
}

// The masking decision for one caller on one collection, computed once per verb.
//
// `maskFor` is what buildSelect calls per column; `masked` is the set the computed-use guard
// checks against. Both come from the same maskedFieldsFor() so the two questions — "is this
// transformed?" and "may this be filtered on?" — can never be answered inconsistently.
function maskPlan(
  cfg: Parameters<typeof maskedFieldsFor>[0],
  collection: string,
  c: CollectionConfig,
  unmasked: readonly string[],
): { masked: Set<string>; maskFor: (field: string) => MaskConfig | null } {
  const masked = new Set(maskedFieldsFor(cfg, collection, unmasked));
  return {
    masked,
    maskFor: (field) => (masked.has(field) ? (c.fields[field]?.mask ?? null) : null),
  };
}
