import type { BrokerContext } from "@warehousd/broker";
import { getClientPolicy, DEFAULT_WORKSPACE_ID } from "@warehousd/broker";
import { auth } from "./auth";
import { envFromScopes, scopesOf } from "./env-scope";
import { resolveWorkspace, workspaceFromScopes } from "./workspace-scope";
import { getAppPool } from "../app/lib/broker";

// The ONLY place BrokerContext is constructed for REST API (`/v1/*`) token-authenticated
// paths — the third and final constructor, per auth protocol boundary.
// lib/session.ts's deriveContext is for cookie/session paths; lib/broker-context.ts's
// deriveTokenContext is for MCP/OAuth paths. Each handles exactly one auth boundary, never
// a shared one.
//
// Tokens carry only sub/client/env/workspace scope (§6.1); any env-like or workspace-like value
// in the request body/params is ignored and never read here. Environment is read from token
// scopes, allowedCollections from the client policy's collection ceiling.
//
// workspaceId, per invariant 8, is never trusted from the token subject's row — a delegated
// client resolves it the same way deriveTokenContext does (resolveWorkspace against the
// `workspace:<id>` scope, intersected with the client policy's own pin). A headless client has
// no interactive holder to name a workspace at all: it stays pinned to client_policies.workspace_id
// outright and ignores any scope, matching how its userId is the policy's robot user rather than
// a signed-in session's.
//
// via derivation: look up client_policies.mode for the clientId, then:
// - headless → api_key:<clientId>
// - delegated + client has registered secrets → token_exchange (configured for /v1/token auth)
// - otherwise → oauth (delegated client with no secrets; only uses interactive OAuth/MCP flow)
export async function deriveRestContext(req: Request): Promise<BrokerContext | null> {
  return (await deriveRestCaller(req))?.ctx ?? null;
}

// The same derivation, plus the client id the token was issued to.
//
// A BrokerContext deliberately does not carry a client id: what bounds a caller on the data plane
// is their grant and the policy's collection ceiling, both already resolved into the context. ACL
// management is not on the data plane — it is authorised against the CLIENT (can_manage_acl), so
// that one route needs the id, and only that route asks for it. Kept as one function rather than a
// second `getMcpSession` call so the two can never disagree about which session they are talking
// about.
export async function deriveRestCaller(
  req: Request,
): Promise<{ ctx: BrokerContext; clientId: string } | null> {
  const session = await auth.api.getMcpSession({ headers: req.headers });
  if (!session) return null;
  const env = envFromScopes(scopesOf(session.scopes));
  const pool = getAppPool();

  const policy = await getClientPolicy(pool, session.clientId || "");

  let workspaceId: string | null;
  if (policy.mode === "headless") {
    // No interactive holder to name a workspace — pinned to the policy outright, any scope
    // ignored. policy.workspaceId is only null for an unregistered client, which a headless
    // session cannot be (getMcpSession already required a real client_policies row to mint the
    // token), so this is a lookup rather than a runtime possibility.
    workspaceId = policy.workspaceId;
  } else {
    workspaceId = await resolveWorkspace(
      pool,
      session.userId,
      workspaceFromScopes(scopesOf(session.scopes)),
    );
    // See the matching comment in lib/broker-context.ts: DEFAULT_WORKSPACE_ID is the column's
    // NOT NULL default, not a deliberate pin, so it is treated as unpinned here too.
    const pinned =
      policy.workspaceId !== null && policy.workspaceId !== DEFAULT_WORKSPACE_ID
        ? policy.workspaceId
        : null;
    if (workspaceId !== null && pinned !== null && workspaceId !== pinned) {
      workspaceId = null;
    }
  }
  if (workspaceId === null) return null;

  // Derive via from client mode + whether delegated client has secrets
  let via: string;
  if (policy.mode === "headless") {
    via = `api_key:${session.clientId}`;
  } else {
    // Delegated clients with registered secrets are configured to authenticate via /v1/token
    // (token-exchange). Those without secrets can only get tokens through the interactive
    // OAuth/MCP flow.
    const secrets = await pool.query(
      `select 1 from app.client_secrets where client_id=$1 and revoked_at is null limit 1`,
      [session.clientId || ""],
    );
    via = (secrets.rowCount ?? 0) > 0 ? "token_exchange" : "oauth";
  }

  return {
    ctx: {
      userId: session.userId,
      workspaceId,
      env,
      allowedCollections: policy.allowedCollections,
      via,
    },
    clientId: session.clientId || "",
  };
}
