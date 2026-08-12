import type { BrokerContext } from "@warehousd/broker";
import { getClientPolicy, DEFAULT_WORKSPACE_ID } from "@warehousd/broker";
import { auth } from "./auth";
import { envFromScopes, scopesOf } from "./env-scope";
import { resolveWorkspace, workspaceFromScopes } from "./workspace-scope";
import { getAppPool } from "../app/lib/broker";

// The ONLY place BrokerContext is constructed for MCP/OAuth token-authenticated paths.
// lib/session.ts's deriveContext is for cookie/session paths; lib/rest-context.ts's
// deriveRestContext is for REST API (`/v1/*`) token paths — three constructors, one per
// auth protocol boundary. Tokens carry only sub/client/env/workspace scope (§6.1, §invariant 8);
// any env-like or workspace-like value in the request body/params is ignored and never read here.
//
// Invariant 8, restated for multi-membership: a caller may name a workspace it is a verified
// member of — the `workspace:<id>` scope, if present, is that claim, and resolveWorkspace
// intersects it with membership loaded at request time rather than trusting it outright. A
// workspace that is absent, unknown, or not a membership yields no context, never a default. In
// practice a live MCP-issued token never carries a `workspace:` scope at all — Better Auth's mcp
// plugin cannot validate one at authorize time (see the drop site in lib/oauth.ts) — so this
// boundary resolves almost entirely through resolveWorkspace's no-scope-requested fallback; the
// scope-reading branch stays here for a token minted by a path that isn't gated by that same
// validation, such as /v1/token's delegated exchange, which lib/rest-context.ts reads through
// the identical getMcpSession lookup. The resolved workspace is then intersected with the client
// policy's own pin, when the policy has one: a client registered under workspace A must not
// reach workspace B just because its holder is a member of both.
//
// A policy whose workspace_id is still DEFAULT_WORKSPACE_ID is treated as unpinned, not pinned to
// 'default': the column is NOT NULL with that default, so every client this codebase can create
// today — most of all a dynamically-registered MCP client, which never carries any workspace
// context at registration (DCR happens before any session exists to read one from) — lands there
// whether or not an admin ever meant to confine it. Only a policy an admin has deliberately
// pinned to a REAL, non-default workspace (apps/web/app/api/api-keys/route.ts, at creation time)
// narrows here; everything else defers entirely to resolveWorkspace's membership check.
//
// allowedCollections carries the client's collection ceiling — the intersection of the user's
// grants with the policy-defined collection restrictions. null = no ceiling (all collections allowed).
export async function deriveTokenContext(req: Request): Promise<BrokerContext | null> {
  const session = await auth.api.getMcpSession({ headers: req.headers });
  if (!session) return null;
  const env = envFromScopes(scopesOf(session.scopes));
  const pool = getAppPool();

  const policy = await getClientPolicy(pool, session.clientId || "");
  let workspaceId = await resolveWorkspace(
    pool,
    session.userId,
    workspaceFromScopes(scopesOf(session.scopes)),
  );
  const pinned =
    policy.workspaceId !== null && policy.workspaceId !== DEFAULT_WORKSPACE_ID
      ? policy.workspaceId
      : null;
  if (workspaceId !== null && pinned !== null && workspaceId !== pinned) {
    workspaceId = null;
  }
  if (workspaceId === null) return null;

  return {
    userId: session.userId,
    workspaceId,
    env,
    allowedCollections: policy.allowedCollections,
    via: "oauth",
  };
}
