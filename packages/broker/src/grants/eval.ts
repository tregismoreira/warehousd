import type { Pool } from "pg";
import type { DocumentFilter } from "../types";

export type ActiveGrant = { id: string; allowedFields: string[]; documentFilter: DocumentFilter[] };

// Loaded fresh on every broker call — grants are never baked into a token/cache.
export async function loadActiveGrant(
  db: Pool, userId: string, collection: string, env: "dev" | "live",
): Promise<ActiveGrant | null> {
  const r = await db.query(
    `select id, allowed_fields, document_filter from app.grants
     where user_id=$1 and collection=$2 and env=$3
       and status='approved' and (expires_at is null or expires_at > now())
     order by requested_at desc limit 1`,
    [userId, collection, env]);
  if (r.rowCount === 0) return null;
  const df = r.rows[0].document_filter;
  // document_filter is a DocumentFilter[]. A row holding the pre-Stage-2 object form is a
  // database that predates this schema and must be rebuilt — coercing it to [] would silently
  // widen a scoped grant to the whole collection, which is the one failure mode worth crashing on.
  if (df !== null && df !== undefined && !Array.isArray(df))
    throw new Error(`grant ${r.rows[0].id}: document_filter is not an array (rebuild the database)`);
  return {
    id: r.rows[0].id,
    allowedFields: r.rows[0].allowed_fields ?? [],
    documentFilter: df ?? [],
  };
}
