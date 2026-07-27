import type { Pool } from "pg";
import type {
  BrokerContext, QueryIntent, DocSearchIntent, BrokerResult, RefusalReason, VisibleSchema, Refusal,
} from "./types";
import type { WarehousdConfig } from "./config/schema";
import type { Pools } from "./db/pools";
import { dataPool } from "./db/pools";
import { loadActiveGrant } from "./grants/eval";
import { buildSelect } from "./sql/build";
import { writeAudit } from "./audit/write";
import { findCollection } from "./config/load";

export function makeBroker(pools: Pools, cfg: WarehousdConfig) {
  const app = pools.app;

  async function refuse(ctx: BrokerContext, collection: string, intent: QueryIntent | DocSearchIntent | null,
    reason: RefusalReason, grantId: string | null = null): Promise<Refusal> {
    const auditId = await writeAudit(app, {
      userId: ctx.userId, env: ctx.env, collection, intent,
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
    const grant = await loadActiveGrant(app, ctx.userId, intent.collection, ctx.env);
    if (!grant) return refuse(ctx, intent.collection, intent, "no_grant");
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
    // 5. build + execute on the env-scoped pool
    try {
      const { text, values } = buildSelect(ctx.env, intent, grant.allowedFields, { documentFilter: grant.documentFilter });
      const documents = (await dataPool(pools, ctx).query(text, values)).rows;
      const fieldsReturned = intent.aggregate && intent.aggregate.length
        ? [...(intent.groupBy ?? []), ...intent.aggregate.map((a) => `${a.fn}_${a.field}`)]
        : selectFields;
      const auditId = await writeAudit(app, {
        userId: ctx.userId, env: ctx.env, collection: intent.collection, intent,
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
    const grant = await loadActiveGrant(app, ctx.userId, name, ctx.env);
    if (!grant) return refuse(ctx, name, null, "no_grant");
    const fields = Object.entries(c.fields)
      .filter(([n]) => grant.allowedFields.includes(n))
      // type is guaranteed by CollectionSchema refinement for structured collections; file collections have types filled in by transform
      .map(([n, f]) => ({ name: n, type: f.type!, pk: f.pk }));
    await writeAudit(app, { userId: ctx.userId, env: ctx.env, collection: name, intent: null,
      fieldsReturned: fields.map((f) => f.name), grantId: grant.id, outcome: "allowed", reason: null });
    return { collection: name, description: c.description, fields };
  }

  async function listCollections(_ctx: BrokerContext): Promise<{ name: string; description: string }[]> {
    return Object.entries(cfg.collections).map(([name, c]) => ({ name, description: c.description }));
  }

  async function searchDocuments(ctx: BrokerContext, intent: DocSearchIntent): Promise<BrokerResult> {
    const c = findCollection(cfg, intent.collection);
    if (!c) return refuse(ctx, intent.collection, intent, "unknown_collection");
    if ((c.type ?? "dataset") !== "file" || typeof intent.q !== "string" || !intent.q.trim())
      return refuse(ctx, intent.collection, intent, "invalid_intent");
    const all = Object.keys(c.fields);
    for (const f of intent.fields ?? []) if (!all.includes(f))
      return refuse(ctx, intent.collection, intent, "unknown_field");
    const grant = await loadActiveGrant(app, ctx.userId, intent.collection, ctx.env);
    if (!grant) return refuse(ctx, intent.collection, intent, "no_grant");
    for (const f of intent.fields ?? []) if (!grant.allowedFields.includes(f))
      return refuse(ctx, intent.collection, intent, "field_denied", grant.id);
    if (grant.documentFilter && !all.includes(grant.documentFilter.field))
      return refuse(ctx, intent.collection, intent, "invalid_intent", grant.id);
    const selectFields = intent.fields && intent.fields.length
      ? intent.fields : grant.allowedFields.filter((f) => all.includes(f));
    try {
      const { text, values } = buildSelect(ctx.env,
        { collection: intent.collection, fields: selectFields, limit: intent.limit, offset: intent.offset } as QueryIntent,
        grant.allowedFields, { q: intent.q, documentFilter: grant.documentFilter });
      const documents = (await dataPool(pools, ctx).query(text, values)).rows;
      const auditId = await writeAudit(app, { userId: ctx.userId, env: ctx.env,
        collection: intent.collection, intent, fieldsReturned: selectFields,
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

  return { query, describeCollection, listCollections, searchDocuments };
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
