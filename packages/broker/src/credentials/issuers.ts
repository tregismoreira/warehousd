import type { Pool } from "pg";

export type TrustedIssuer = {
  id: string;
  orgId: string;
  issuer: string;
  jwksUri: string;
  audience: string;
  subjectClaim: string;
  createdAt: Date;
};

export async function createTrustedIssuer(
  db: Pool,
  orgId: string,
  issuer: string,
  jwksUri: string,
  audience: string,
  subjectClaim: string = "sub",
): Promise<TrustedIssuer> {
  const r = await db.query(
    `insert into app.trusted_issuers (org_id, issuer, jwks_uri, audience, subject_claim)
     values ($1, $2, $3, $4, $5)
     returning id, org_id, issuer, jwks_uri, audience, subject_claim, created_at`,
    [orgId, issuer, jwksUri, audience, subjectClaim],
  );

  const row = r.rows[0];
  return {
    id: row.id,
    orgId: row.org_id,
    issuer: row.issuer,
    jwksUri: row.jwks_uri,
    audience: row.audience,
    subjectClaim: row.subject_claim,
    createdAt: new Date(row.created_at),
  };
}

export async function listTrustedIssuers(db: Pool, orgId: string): Promise<TrustedIssuer[]> {
  const r = await db.query(
    `select id, org_id, issuer, jwks_uri, audience, subject_claim, created_at
     from app.trusted_issuers
     where org_id=$1
     order by created_at desc`,
    [orgId],
  );

  return r.rows.map((row) => ({
    id: row.id,
    orgId: row.org_id,
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
  orgId: string,
): Promise<TrustedIssuer | null> {
  const r = await db.query(
    `select id, org_id, issuer, jwks_uri, audience, subject_claim, created_at
     from app.trusted_issuers
     where id=$1 and org_id=$2`,
    [id, orgId],
  );

  if (r.rowCount === 0) return null;

  const row = r.rows[0];
  return {
    id: row.id,
    orgId: row.org_id,
    issuer: row.issuer,
    jwksUri: row.jwks_uri,
    audience: row.audience,
    subjectClaim: row.subject_claim,
    createdAt: new Date(row.created_at),
  };
}
