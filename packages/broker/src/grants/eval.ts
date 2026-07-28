import type { Pool } from "pg";
import type { DocumentFilter } from "../types";

export type ActiveGrant = {
  id: string;
  allowedFields: string[];
  documentFilter: DocumentFilter | null;
  verbs: string[];
  mode: string;
};

// Loaded fresh on every broker call — grants are never baked into a token/cache.
//
// It takes the whole context rather than spread parameters on purpose. The collection ceiling
// lives here so that no broker verb can forget it, and a trailing optional argument is exactly
// how a caller forgets: five call sites had already dropped it while still type-checking.
// Passing `ctx` means adding a future dimension cannot silently skip any of them.
export async function loadActiveGrant(
  db: Pool,
  ctx: { userId: string; orgId: string; env: "dev" | "live"; allowedCollections?: string[] | null },
  collection: string,
): Promise<ActiveGrant | null> {
  const { userId, orgId, env, allowedCollections } = ctx;

  // The client's collection ceiling. It only ever narrows: a collection outside it returns null,
  // so every verb refuses `no_grant` uniformly. A distinguishable code would tell an app exactly
  // which collections it is missing.
  if (allowedCollections != null && !allowedCollections.includes(collection)) return null;

  const r = await db.query(
    `select id, allowed_fields, document_filter, verbs, mode from app.grants
     where user_id=$1 and collection=$2 and env=$3 and org_id=$4
       and status='approved' and (expires_at is null or expires_at > now())
     order by requested_at desc limit 1`,
    [userId, collection, env, orgId]);
  if (r.rowCount === 0) return null;

  // Resolve $self in document_filter
  let documentFilter = r.rows[0].document_filter ?? null;
  if (documentFilter) {
    if (documentFilter.value === "$self") {
      documentFilter = { ...documentFilter, value: userId };
    } else if (documentFilter.op === "in" && Array.isArray(documentFilter.value)) {
      documentFilter = {
        ...documentFilter,
        value: documentFilter.value.map((v: unknown) => v === "$self" ? userId : v),
      };
    }
  }

  return {
    id: r.rows[0].id,
    allowedFields: r.rows[0].allowed_fields ?? [],
    documentFilter,
    verbs: r.rows[0].verbs ?? ["read"],
    mode: r.rows[0].mode ?? "direct",
  };
}
