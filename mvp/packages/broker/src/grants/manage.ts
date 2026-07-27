import type { Pool } from "pg";
import type { DocumentFilter } from "../types";
import type { WarehousdConfig } from "../config/schema";
import { findCollection, grantableFields } from "../config/load";

export type GrantRequestError = "unknown_collection" | "purpose_required" | "field_not_grantable";

// Validation lives here, not in the callers: the web route and the MCP request_access
// tool both reach app.grants, and a rule enforced in only one of them is not a rule.
export function validateGrantRequest(
  cfg: WarehousdConfig, collection: string, purposeLabel: unknown, fields: unknown,
): { ok: true; fields: string[] } | { ok: false; error: GrantRequestError } {
  // Check collection exists
  const c = findCollection(cfg, collection);
  if (!c) return { ok: false, error: "unknown_collection" };

  // Check purpose is a non-empty trimmed string
  if (typeof purposeLabel !== "string" || !purposeLabel.trim())
    return { ok: false, error: "purpose_required" };

  // Get grantable fields for this collection
  const grantable = grantableFields(cfg, collection);

  // Default to all grantable fields if not specified, otherwise use provided fields
  const requested: string[] = Array.isArray(fields) && fields.length ? fields : grantable;

  // Validate all requested fields are grantable (posture:allow)
  for (const f of requested)
    if (!grantable.includes(f))
      return { ok: false, error: "field_not_grantable" };

  return { ok: true, fields: requested };
}

export async function requestGrant(app: Pool, i: {
  userId: string; collection: string; env: "dev" | "live";
  purposeLabel: string; purposeDetail?: string; allowedFields: string[];
}): Promise<string> {
  const r = await app.query(
    `insert into app.grants (user_id,collection,env,purpose_label,purpose_detail,allowed_fields,status)
     values ($1,$2,$3,$4,$5,$6,'pending') returning id`,
    [i.userId, i.collection, i.env, i.purposeLabel, i.purposeDetail ?? null, i.allowedFields]);
  return r.rows[0].id;
}

export async function approveGrant(app: Pool, id: string, by: string,
  opts: { allowedFields?: string[]; expiresAt?: string; documentFilter?: DocumentFilter } = {}): Promise<boolean> {
  const result = await app.query(
    `update app.grants set status='approved', decided_by=$2, decided_at=now(),
       allowed_fields=coalesce($3, allowed_fields), expires_at=$4, document_filter=$5
     where id=$1 and status='pending'`,
    [id, by, opts.allowedFields ?? null, opts.expiresAt ?? null,
     opts.documentFilter ? JSON.stringify(opts.documentFilter) : null]);
  return (result.rowCount ?? 0) > 0;
}

export async function denyGrant(app: Pool, id: string, by: string): Promise<boolean> {
  const result = await app.query(`update app.grants set status='denied', decided_by=$2, decided_at=now()
    where id=$1 and status='pending'`, [id, by]);
  return (result.rowCount ?? 0) > 0;
}

export async function revokeGrant(app: Pool, id: string, by: string): Promise<boolean> {
  const result = await app.query(`update app.grants set status='revoked', decided_by=$2, decided_at=now()
    where id=$1 and status='approved'`, [id, by]);
  return (result.rowCount ?? 0) > 0;
}
