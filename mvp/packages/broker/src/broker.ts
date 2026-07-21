import type { Pool } from "pg";
import type {
  BrokerContext, QueryIntent, BrokerResult, RefusalReason, VisibleSchema, Refusal,
} from "./types";
import type { WarehousdConfig } from "./config/schema";
import type { Pools } from "./db/pools";
import { dataPool } from "./db/pools";
import { loadActiveGrant } from "./grants/eval";
import { buildSelect } from "./sql/build";
import { writeAudit } from "./audit/write";

export function makeBroker(pools: Pools, cfg: WarehousdConfig) {
  const app = pools.app;

  async function refuse(ctx: BrokerContext, collection: string, intent: QueryIntent | null,
    reason: RefusalReason, grantId: string | null = null): Promise<Refusal> {
    const auditId = await writeAudit(app, {
      userId: ctx.userId, env: ctx.env, collection, intent,
      fieldsReturned: [], grantId, outcome: "refused", reason });
    return { ok: false, reason, auditId };
  }

  function fieldsOf(collection: string): string[] | null {
    const c = cfg.collections[collection];
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
    // row_filter is grant-author-supplied; its field is validated against the collection's
    // full YAML field set (NOT allowedFields) so denied fields like `path` can gate rows.
    if (grant.rowFilter && !all.includes(grant.rowFilter.field))
      return refuse(ctx, intent.collection, intent, "invalid_intent", grant.id);
    // fields to select: explicit, else all granted fields present on the collection
    const selectFields = intent.fields && intent.fields.length
      ? intent.fields
      : grant.allowedFields.filter((f) => all.includes(f));
    // 5. build + execute on the env-scoped pool
    const { text, values } = buildSelect(ctx.env, intent, grant.allowedFields, { rowFilter: grant.rowFilter });
    const rows = (await dataPool(pools, ctx).query(text, values)).rows;
    const fieldsReturned = intent.aggregate && intent.aggregate.length
      ? [...(intent.groupBy ?? []), ...intent.aggregate.map((a) => `${a.fn}_${a.field}`)]
      : selectFields;
    const auditId = await writeAudit(app, {
      userId: ctx.userId, env: ctx.env, collection: intent.collection, intent,
      fieldsReturned, grantId: grant.id, outcome: "allowed", reason: null });
    return { ok: true, rows, fieldsReturned, auditId };
  }

  async function describeCollection(ctx: BrokerContext, name: string): Promise<VisibleSchema | Refusal> {
    const c = cfg.collections[name];
    if (!c) return refuse(ctx, name, null, "unknown_collection");
    const grant = await loadActiveGrant(app, ctx.userId, name, ctx.env);
    if (!grant) return refuse(ctx, name, null, "no_grant");
    const fields = Object.entries(c.fields)
      .filter(([n]) => grant.allowedFields.includes(n))
      // type is guaranteed by CollectionSchema refinement for structured collections; document collections have types filled in by transform
      .map(([n, f]) => ({ name: n, type: f.type!, pk: f.pk }));
    await writeAudit(app, { userId: ctx.userId, env: ctx.env, collection: name, intent: null,
      fieldsReturned: fields.map((f) => f.name), grantId: grant.id, outcome: "allowed", reason: null });
    return { collection: name, description: c.description, fields };
  }

  async function listCollections(_ctx: BrokerContext): Promise<{ name: string; description: string }[]> {
    return Object.entries(cfg.collections).map(([name, c]) => ({ name, description: c.description }));
  }

  return { query, describeCollection, listCollections };
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
