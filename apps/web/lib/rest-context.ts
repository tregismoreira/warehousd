import type { BrokerContext } from "@warehousd/broker";
import { DEFAULT_ORG_ID } from "@warehousd/broker";
import { auth } from "./auth";
import { envFromScopes, scopesOf } from "./env-scope";
import { getAppPool } from "../app/lib/broker";

// The ONLY place BrokerContext is constructed for REST API (`/v1/*`) token-authenticated
// paths — the third and final constructor, per auth protocol boundary.
// lib/session.ts's deriveContext is for cookie/session paths; lib/broker-context.ts's
// deriveTokenContext is for MCP/OAuth paths. Each handles exactly one auth boundary, never
// a shared one.
//
// Tokens carry only sub/client/env scope (§6.1); any env-like value in the request body/params
// is ignored and never read here. Environment is read from token scopes, orgId from the
// token's userId's user row, allowedCollections from the client policy's collection ceiling.
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

  // Derive orgId from token's userId's user record
  const r = await pool.query(`select "orgId" from app."user" where id=$1`, [session.userId]);
  const orgId = r.rows[0]?.orgId ?? DEFAULT_ORG_ID;

  // Load client policy to get mode (for via derivation) and collection ceiling
  const cp = await pool.query(
    `select mode, allowed_collections from app.client_policies where client_id=$1`,
    [session.clientId || ""],
  );
  const policy = cp.rows[0];
  const allowedCollections = policy?.allowed_collections ?? null;

  // Derive via from client mode + whether delegated client has secrets
  let via: string;
  if (policy?.mode === "headless") {
    via = `api_key:${session.clientId}`;
  } else if (policy?.mode === "delegated") {
    // Delegated clients with registered secrets are configured to authenticate via /v1/token
    // (token-exchange). Those without secrets can only get tokens through the interactive
    // OAuth/MCP flow.
    const secrets = await pool.query(
      `select 1 from app.client_secrets where client_id=$1 and revoked_at is null limit 1`,
      [session.clientId || ""],
    );
    via = (secrets.rowCount ?? 0) > 0 ? "token_exchange" : "oauth";
  } else {
    via = "oauth";
  }

  return {
    ctx: {
      userId: session.userId,
      orgId,
      env,
      allowedCollections,
      via,
    },
    clientId: session.clientId || "",
  };
}
