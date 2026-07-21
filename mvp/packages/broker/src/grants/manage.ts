import type { Pool } from "pg";

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
  opts: { allowedFields?: string[]; expiresAt?: string } = {}): Promise<void> {
  await app.query(
    `update app.grants set status='approved', decided_by=$2, decided_at=now(),
       allowed_fields=coalesce($3, allowed_fields), expires_at=$4
     where id=$1 and status='pending'`,
    [id, by, opts.allowedFields ?? null, opts.expiresAt ?? null]);
}

export async function denyGrant(app: Pool, id: string, by: string): Promise<void> {
  await app.query(`update app.grants set status='denied', decided_by=$2, decided_at=now()
    where id=$1 and status='pending'`, [id, by]);
}

export async function revokeGrant(app: Pool, id: string, by: string): Promise<void> {
  await app.query(`update app.grants set status='revoked', decided_by=$2, decided_at=now() where id=$1`, [id, by]);
}
