import type { Pool } from "pg";
import type { BrokerContext, DocumentFilter } from "../types";

export type ActiveGrant = {
  id: string;
  allowedFields: string[];
  // Subset of allowedFields whose raw value this grant carries. Every other masked field comes
  // back transformed. Empty is the default and the safe answer.
  unmaskedFields: string[];
  documentFilter: DocumentFilter[];
  verbs: string[];
  mode: string;
};

// Loaded fresh on every broker call — grants are never baked into a token/cache.
//
// It takes the whole context rather than spread parameters on purpose. The collection ceiling
// lives here so that no broker verb can forget it, and a trailing optional argument is exactly
// how a caller forgets: five call sites had already dropped it while still type-checking.
// Passing `ctx` means adding a future dimension cannot silently skip any of them — and the field
// is now required on BrokerContext, so it cannot be dropped from the context either.
export async function loadActiveGrant(
  db: Pool,
  ctx: Pick<BrokerContext, "userId" | "orgId" | "env" | "allowedCollections">,
  collection: string,
): Promise<ActiveGrant | null> {
  const { userId, orgId, env, allowedCollections } = ctx;

  // The client's collection ceiling. It only ever narrows: a collection outside it returns null,
  // so every verb refuses `no_grant` uniformly. A distinguishable code would tell an app exactly
  // which collections it is missing.
  if (allowedCollections != null && !allowedCollections.includes(collection)) return null;

  const r = await db.query(
    `select id, allowed_fields, unmasked_fields, document_filter, verbs, mode from app.grants
     where user_id=$1 and collection=$2 and env=$3 and org_id=$4
       and status='approved' and (expires_at is null or expires_at > now())
     order by requested_at desc limit 1`,
    [userId, collection, env, orgId],
  );
  if (r.rowCount === 0) return null;
  const df = r.rows[0].document_filter;
  // document_filter is a DocumentFilter[]. A row holding the pre-Stage-2 object form is a
  // database that predates this schema and must be rebuilt — coercing it to [] would silently
  // widen a scoped grant to the whole collection, which is the one failure mode worth crashing on.
  if (df !== null && df !== undefined && !Array.isArray(df))
    throw new Error(
      `grant ${r.rows[0].id}: document_filter is not an array (rebuild the database)`,
    );

  // Resolve $self, per predicate and per element inside an `in` list. Binding happens here so
  // no caller can forget it and the SQL builder still sees a plain literal. Only the exact
  // string is a sentinel — "$self-service" is a literal, and there is no substring interpolation.
  const documentFilter: DocumentFilter[] = ((df ?? []) as DocumentFilter[]).map((f) => {
    if (f.value === "$self") return { ...f, value: userId };
    if (f.op === "in" && Array.isArray(f.value))
      return { ...f, value: f.value.map((v: unknown) => (v === "$self" ? userId : v)) };
    return f;
  });

  return {
    id: r.rows[0].id,
    allowedFields: r.rows[0].allowed_fields ?? [],
    // Which of those fields come back RAW rather than transformed. Never widened here: a field
    // only reaches this column if approveGrant checked its posture declares `unmask: allow`.
    unmaskedFields: r.rows[0].unmasked_fields ?? [],
    documentFilter,
    verbs: r.rows[0].verbs ?? ["read"],
    mode: r.rows[0].mode ?? "direct",
  };
}
