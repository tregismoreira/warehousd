import type { Pool } from "pg";

export type TrustedIssuer = {
  id: string;
  workspaceId: string;
  issuer: string;
  jwksUri: string;
  audience: string;
  subjectClaim: string;
  createdAt: Date;
};

export async function createTrustedIssuer(
  db: Pool,
  workspaceId: string,
  issuer: string,
  jwksUri: string,
  audience: string,
  subjectClaim: string = "sub",
): Promise<TrustedIssuer> {
  const r = await db.query(
    `insert into app.trusted_issuers (workspace_id, issuer, jwks_uri, audience, subject_claim)
     values ($1, $2, $3, $4, $5)
     returning id, workspace_id, issuer, jwks_uri, audience, subject_claim, created_at`,
    [workspaceId, issuer, jwksUri, audience, subjectClaim],
  );

  const row = r.rows[0];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    issuer: row.issuer,
    jwksUri: row.jwks_uri,
    audience: row.audience,
    subjectClaim: row.subject_claim,
    createdAt: new Date(row.created_at),
  };
}

export async function listTrustedIssuers(db: Pool, workspaceId: string): Promise<TrustedIssuer[]> {
  const r = await db.query(
    `select id, workspace_id, issuer, jwks_uri, audience, subject_claim, created_at
     from app.trusted_issuers
     where workspace_id=$1
     order by created_at desc`,
    [workspaceId],
  );

  return r.rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    issuer: row.issuer,
    jwksUri: row.jwks_uri,
    audience: row.audience,
    subjectClaim: row.subject_claim,
    createdAt: new Date(row.created_at),
  }));
}

export async function getTrustedIssuer(
  db: Pool,
  id: string,
  workspaceId: string,
): Promise<TrustedIssuer | null> {
  const r = await db.query(
    `select id, workspace_id, issuer, jwks_uri, audience, subject_claim, created_at
     from app.trusted_issuers
     where id=$1 and workspace_id=$2`,
    [id, workspaceId],
  );

  if (r.rowCount === 0) return null;

  const row = r.rows[0];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    issuer: row.issuer,
    jwksUri: row.jwks_uri,
    audience: row.audience,
    subjectClaim: row.subject_claim,
    createdAt: new Date(row.created_at),
  };
}
