import type { Pool } from "pg";
import type { DocumentFilter } from "../types";

export type ActiveGrant = { id: string; allowedFields: string[]; documentFilter: DocumentFilter | null };

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
  return {
    id: r.rows[0].id,
    allowedFields: r.rows[0].allowed_fields ?? [],
    documentFilter: r.rows[0].document_filter ?? null,
  };
}
