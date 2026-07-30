import type { Pool } from "pg";
import { randomBytes, createHash } from "node:crypto";
import { DEFAULT_ORG_ID } from "../db/migrate-app";

export const DEV_CLIENT_NAME = "warehousd dev client";

export type ClientPolicy = {
  clientId: string;
  allowedScopes: string[];
  allowedCollections: string[] | null;
  mode: "delegated" | "headless";
  robotUserId: string | null;
  trustedIssuerId: string | null;
};

export async function getClientPolicy(app: Pool, clientId: string): Promise<ClientPolicy> {
  const r = await app.query(
    `select allowed_scopes, allowed_collections, mode, robot_user_id, trusted_issuer_id
     from app.client_policies where client_id=$1`, [clientId]);
  if (r.rowCount === 0) {
    return {
      clientId,
      allowedScopes: ["env:dev"],
      allowedCollections: null,
      mode: "delegated",
      robotUserId: null,
      trustedIssuerId: null,
    };
  }
  const row = r.rows[0];
  return {
    clientId,
    allowedScopes: row.allowed_scopes,
    allowedCollections: row.allowed_collections,
    mode: row.mode || "delegated",
    robotUserId: row.robot_user_id,
    trustedIssuerId: row.trusted_issuer_id,
  };
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

export async function hasApprovedLiveGrant(
  app: Pool, userId: string, orgId = DEFAULT_ORG_ID,
): Promise<boolean> {
  // NULL expires_at means "no expiry", matching loadActiveGrant (grants/eval.ts).
  // The two must agree: a grant the broker honors must also make the user
  // eligible for the env:live scope, or live access silently half-works. That includes the
  // org predicate — loadActiveGrant keys on it, so eligibility has to as well, or a token
  // could be issued for an env the broker will then refuse to serve.
  const r = await app.query(
    `select 1 from app.grants
     where org_id=$2 and user_id=$1 and env='live' and status='approved'
       and (expires_at is null or expires_at > now()) limit 1`,
    [userId, orgId]);
  return (r.rowCount ?? 0) > 0;
}

// Better Auth's own client-secret hasher, reproduced: base64url(sha256(secret)), unpadded. It has
// to match byte for byte, because Better Auth is what verifies this column — the oidc provider is
// configured with storeClientSecret: "hashed" and compares defaultClientSecretHasher(presented)
// against what is stored (better-auth/dist/plugins/oidc-provider/utils.mjs).
//
// SHA-256 with no salt or stretching is weak for a human password and right for this: a client
// secret is 32 bytes of CSPRNG output, so there is no dictionary to run and nothing to slow down.
// Matching the library's format matters more than choosing our own.
export function hashOauthClientSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

// Returns the client's id only. The secret is not readable: the column holds a hash, and this
// used to hand back the plaintext it stored — which is why the column was plaintext at all.
// A caller that needs the secret is the caller that supplied it (see ensureDevClient).
export async function getDevClient(app: Pool): Promise<{ clientId: string } | null> {
  const r = await app.query(
    `select "clientId" from app."oauthApplication" where name=$1 limit 1`,
    [DEV_CLIENT_NAME]);
  if (r.rowCount === 0) return null;
  return { clientId: r.rows[0].clientId };
}

// `secret` is supplied by the caller rather than generated here, so that the process which has to
// *print* it is the one that knows it: the database keeps only a hash, so nothing can read it back
// on a later boot. The CLI generates it into .warehousd/state.json (mode 0600) alongside the other
// secrets and passes it to the container as WAREHOUSD_DEV_CLIENT_SECRET.
//
// When a secret IS supplied the stored hash is (re)asserted every time. That is both idempotent —
// the same value arrives on every boot — and self-healing: a row written when this column held
// plaintext would now fail verification, and the next boot rewrites it.
//
// When one is NOT supplied and a client already exists, the stored hash is left alone and
// `clientSecret` comes back null. Rewriting it would rotate the credential on every restart and
// silently break whatever was configured with it — which is exactly what an earlier draft of this
// did, caught by the entrypoint idempotency test.
export async function ensureDevClient(
  app: Pool, ownerUserId: string | null, secret?: string,
): Promise<{ clientId: string; clientSecret: string | null }> {
  const existing = await getDevClient(app);
  if (existing) {
    // Re-assert the policy in case the row was created before client_policies existed.
    await upsertClientPolicy(app, existing.clientId, DEV_CLIENT_NAME, ["env:dev"]);
    if (secret === undefined) return { clientId: existing.clientId, clientSecret: null };
    await app.query(
      `update app."oauthApplication" set "clientSecret"=$2, "updatedAt"=now() where "clientId"=$1`,
      [existing.clientId, hashOauthClientSecret(secret)]);
    return { clientId: existing.clientId, clientSecret: secret };
  }

  const clientSecret = secret ?? randomBytes(32).toString("hex");
  const id = randomBytes(16).toString("hex");
  const clientId = randomBytes(16).toString("hex");
  // Better Auth's mcp authorize handler reads "redirectUrls" as a comma-separated
  // string (`res.redirectUrls.split(",")`), not JSON — a JSON-encoded value here
  // would never match a real redirect_uri and every authorize call would 400.
  await app.query(
    `insert into app."oauthApplication"
       ("id","clientId","clientSecret",name,type,"redirectUrls","userId","createdAt","updatedAt")
     values ($1,$2,$3,$4,'web',$5,$6,now(),now())`,
    [id, clientId, hashOauthClientSecret(clientSecret), DEV_CLIENT_NAME,
     "http://localhost/callback", ownerUserId]);
  await upsertClientPolicy(app, clientId, DEV_CLIENT_NAME, ["env:dev"]);
  return { clientId, clientSecret };
}
