import type { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { DEFAULT_WORKSPACE_ID } from "../db/migrate-app";

export const DEV_CLIENT_NAME = "warehousd dev client";

export type ClientPolicy = {
  clientId: string;
  allowedScopes: string[];
  allowedCollections: string[] | null;
  mode: "delegated" | "headless";
  robotUserId: string | null;
  trustedIssuerId: string | null;
  // May this client edit a document's ACL? Not a grant verb and not a scope: a grant says what a
  // caller may read, and widening who else may read something is a different act. Default false,
  // and an unregistered client gets false too — the flag is only ever granted on purpose.
  canManageAcl: boolean;
  // The workspace this client is pinned to, or null for an unregistered client (no row at all —
  // never for a registered one, since the column is not-null with a default). The two token
  // context constructors (broker-context.ts, rest-context.ts) intersect this against the
  // resolved workspace: null means "no pin, do not restrict."
  workspaceId: string | null;
};

export async function getClientPolicy(app: Pool, clientId: string): Promise<ClientPolicy> {
  const r = await app.query(
    `select allowed_scopes, allowed_collections, mode, robot_user_id, trusted_issuer_id,
            can_manage_acl, workspace_id
     from app.client_policies where client_id=$1`,
    [clientId],
  );
  if (r.rowCount === 0) {
    return {
      clientId,
      allowedScopes: ["env:dev"],
      allowedCollections: null,
      mode: "delegated",
      robotUserId: null,
      trustedIssuerId: null,
      canManageAcl: false,
      workspaceId: null,
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
    canManageAcl: row.can_manage_acl === true,
    workspaceId: row.workspace_id,
  };
}

// Grant or withdraw a client's ability to edit document ACLs.
//
// Scoped to the workspace like every other client-policy write, and audited by the caller rather than
// here — the console route that owns this is the one holding the acting admin's identity.
export async function setCanManageAcl(
  app: Pool,
  clientId: string,
  canManageAcl: boolean,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<boolean> {
  const r = await app.query(
    `update app.client_policies set can_manage_acl=$2 where client_id=$1 and workspace_id=$3`,
    [clientId, canManageAcl, workspaceId],
  );
  return (r.rowCount ?? 0) > 0;
}

// `workspaceId` defaults to DEFAULT_WORKSPACE_ID for the three existing callers (DCR, the dev
// client), none of which ever had a workspace to pin to. The platform API's client-creation route
// is the first caller that passes a real one — a client created for tenant A must be pinned to A,
// not left to land in 'default' by the column's own NOT NULL default. Not part of the ON CONFLICT
// update: a client's workspace is set once, at creation, the same way its scopes are widened only
// through setAllowedScopes rather than through a re-upsert.
export async function upsertClientPolicy(
  app: Pool,
  clientId: string,
  displayName: string | null,
  allowedScopes: string[],
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<void> {
  await app.query(
    `insert into app.client_policies (client_id, display_name, allowed_scopes, workspace_id)
     values ($1,$2,$3,$4)
     on conflict (client_id) do update set display_name=$2, allowed_scopes=$3`,
    [clientId, displayName, allowedScopes, workspaceId],
  );
}

// Scoped to the workspace like setCanManageAcl: without it, any manager could promote or demote
// another workspace's client by guessing its id — there is no other check anywhere in the call
// chain that a client belongs to the caller's workspace. Returns whether a row matched, the same
// shape as setCanManageAcl, so the caller can tell a wrong-workspace clientId from a real update.
export async function setAllowedScopes(
  app: Pool,
  clientId: string,
  allowedScopes: string[],
  by: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<boolean> {
  const r = await app.query(
    `update app.client_policies set allowed_scopes=$2, promoted_at=now(), promoted_by=$3
     where client_id=$1 and workspace_id=$4`,
    [clientId, allowedScopes, by, workspaceId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function hasApprovedLiveGrant(
  app: Pool,
  userId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): Promise<boolean> {
  // NULL expires_at means "no expiry", matching loadActiveGrant (grants/eval.ts).
  // The two must agree: a grant the broker honors must also make the user
  // eligible for the env:live scope, or live access silently half-works. That includes the
  // workspace predicate — loadActiveGrant keys on it, so eligibility has to as well, or a token
  // could be issued for an env the broker will then refuse to serve.
  const r = await app.query(
    `select 1 from app.grants
     where workspace_id=$2 and user_id=$1 and env='live' and status='approved'
       and (expires_at is null or expires_at > now()) limit 1`,
    [userId, workspaceId],
  );
  return (r.rowCount ?? 0) > 0;
}

// Returns the client's id only. A caller that needs the secret is the caller that supplied it
// (see ensureDevClient) — nothing reads it back out of the database, which is what keeps the CLI
// from having to re-read a credential it already holds.
export async function getDevClient(app: Pool): Promise<{ clientId: string } | null> {
  const r = await app.query(`select "clientId" from app."oauthApplication" where name=$1 limit 1`, [
    DEV_CLIENT_NAME,
  ]);
  if (r.rowCount === 0) return null;
  return { clientId: r.rows[0].clientId };
}

// `secret` is supplied by the caller rather than generated here, so that the process which has to
// *print* it is the one that knows it. The CLI generates it into .warehousd/state.json (mode 0600)
// alongside the other secrets and passes it to the container as WAREHOUSD_DEV_CLIENT_SECRET.
//
// The column holds the secret verbatim, because Better Auth's mcp plugin authenticates the token
// endpoint by comparing this column to the presented value directly
// (`client.clientSecret === client_secret`, dist/plugins/mcp/index.mjs) rather than through the
// oidc provider's configurable verifier. Storing a hash here makes every /api/auth/mcp/token
// exchange fail with `invalid client_secret` — which is exactly what it did, caught by the CLI
// lifecycle e2e's Step 6. See the note in apps/web/lib/oauth.ts and SECURITY.md.
//
// When a secret IS supplied the stored value is re-asserted every time: idempotent, since the same
// value arrives on every boot, and self-healing for a row left holding a hash by an earlier build.
//
// When one is NOT supplied and a client already exists, the stored value is left alone and
// `clientSecret` comes back null. Rewriting it would rotate the credential on every restart and
// silently break whatever was configured with it — which is exactly what an earlier draft of this
// did, caught by the entrypoint idempotency test.
export async function ensureDevClient(
  app: Pool,
  ownerUserId: string | null,
  secret?: string,
): Promise<{ clientId: string; clientSecret: string | null }> {
  const existing = await getDevClient(app);
  if (existing) {
    // Re-assert the policy in case the row was created before client_policies existed.
    await upsertClientPolicy(app, existing.clientId, DEV_CLIENT_NAME, ["env:dev"]);
    if (secret === undefined) return { clientId: existing.clientId, clientSecret: null };
    await app.query(
      `update app."oauthApplication" set "clientSecret"=$2, "updatedAt"=now() where "clientId"=$1`,
      [existing.clientId, secret],
    );
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
    [id, clientId, clientSecret, DEV_CLIENT_NAME, "http://localhost/callback", ownerUserId],
  );
  await upsertClientPolicy(app, clientId, DEV_CLIENT_NAME, ["env:dev"]);
  return { clientId, clientSecret };
}
