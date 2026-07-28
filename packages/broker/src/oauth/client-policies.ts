import type { Pool } from "pg";
import { randomBytes } from "node:crypto";

export const DEV_CLIENT_NAME = "warehousd dev client";

export type ClientPolicy = { clientId: string; allowedScopes: string[] };

export async function getClientPolicy(app: Pool, clientId: string): Promise<ClientPolicy> {
  const r = await app.query(`select allowed_scopes from app.client_policies where client_id=$1`, [clientId]);
  if (r.rowCount === 0) return { clientId, allowedScopes: ["env:dev"] };
  return { clientId, allowedScopes: r.rows[0].allowed_scopes };
}

export async function upsertClientPolicy(
  app: Pool, clientId: string, displayName: string | null, allowedScopes: string[],
): Promise<void> {
  await app.query(
    `insert into app.client_policies (client_id, display_name, allowed_scopes)
     values ($1,$2,$3)
     on conflict (client_id) do update set display_name=$2, allowed_scopes=$3`,
    [clientId, displayName, allowedScopes]);
}

export async function setAllowedScopes(
  app: Pool, clientId: string, allowedScopes: string[], by: string,
): Promise<void> {
  await app.query(
    `update app.client_policies set allowed_scopes=$2, promoted_at=now(), promoted_by=$3 where client_id=$1`,
    [clientId, allowedScopes, by]);
}

export async function hasApprovedLiveGrant(app: Pool, userId: string): Promise<boolean> {
  // NULL expires_at means "no expiry", matching loadActiveGrant (grants/eval.ts).
  // The two must agree: a grant the broker honors must also make the user
  // eligible for the env:live scope, or live access silently half-works.
  const r = await app.query(
    `select 1 from app.grants
     where user_id=$1 and env='live' and status='approved'
       and (expires_at is null or expires_at > now()) limit 1`,
    [userId]);
  return (r.rowCount ?? 0) > 0;
}

export async function getDevClient(app: Pool): Promise<{ clientId: string; clientSecret: string } | null> {
  const r = await app.query(
    `select "clientId", "clientSecret" from app."oauthApplication" where name=$1 limit 1`,
    [DEV_CLIENT_NAME]);
  if (r.rowCount === 0) return null;
  return { clientId: r.rows[0].clientId, clientSecret: r.rows[0].clientSecret };
}

export async function ensureDevClient(app: Pool, ownerUserId: string | null): Promise<{ clientId: string; clientSecret: string }> {
  const existing = await getDevClient(app);
  if (existing) {
    // Re-assert the policy in case the row was created before client_policies existed.
    await upsertClientPolicy(app, existing.clientId, DEV_CLIENT_NAME, ["env:dev"]);
    return existing;
  }
  const id = randomBytes(16).toString("hex");
  const clientId = randomBytes(16).toString("hex");
  const clientSecret = randomBytes(32).toString("hex");
  // Better Auth's mcp authorize handler reads "redirectUrls" as a comma-separated
  // string (`res.redirectUrls.split(",")`), not JSON — a JSON-encoded value here
  // would never match a real redirect_uri and every authorize call would 400.
  await app.query(
    `insert into app."oauthApplication"
       ("id","clientId","clientSecret",name,type,"redirectUrls","userId","createdAt","updatedAt")
     values ($1,$2,$3,$4,'web',$5,$6,now(),now())`,
    [id, clientId, clientSecret, DEV_CLIENT_NAME, "http://localhost/callback", ownerUserId]);
  await upsertClientPolicy(app, clientId, DEV_CLIENT_NAME, ["env:dev"]);
  return { clientId, clientSecret };
}
