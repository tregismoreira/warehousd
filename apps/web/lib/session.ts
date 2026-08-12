import type { BrokerContext } from "@warehousd/broker";
import { auth, type SessionUser } from "./auth";
import { resolveWorkspace } from "./workspace-scope";
import { getAppPool } from "../app/lib/broker";

export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const s = await auth.api.getSession({ headers: req.headers });
  if (!s?.user) return null;
  return s.user as SessionUser;
}

// The one place `session.activeWorkspaceId` becomes a workspace id, defaulted. Shared by
// getSessionData below and by the three console layouts, which call auth.api.getSession
// directly (they hold headers from next/headers, not a Request) and need the same default.
export function activeWorkspaceIdFromSession(session: { session: unknown }): string {
  return (session.session as { activeWorkspaceId?: string }).activeWorkspaceId ?? "default";
}

// user plus the two pieces of session state (not user state) that resolveWorkspace and the
// switch route (`/api/me/workspace`) need: which session row to update, and which workspace it
// currently names. Session-scoped rather than user-scoped so switching workspaces in one tab
// never touches another tab's session.
export async function getSessionData(
  req: Request,
): Promise<{ user: SessionUser; sessionId: string; activeWorkspaceId: string } | null> {
  const s = await auth.api.getSession({ headers: req.headers });
  if (!s?.user) return null;
  return {
    user: s.user as SessionUser,
    sessionId: s.session.id,
    activeWorkspaceId: activeWorkspaceIdFromSession(s),
  };
}

// Env is a session-scoped console value read ONLY from the signed cookie, never from
// the request body/params (see docs/architecture.md). Default dev.
export function readEnvCookie(req: Request): "dev" | "live" {
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)wh_env=(dev|live)(?:;|$)/);
  return m?.[1] === "live" ? "live" : "dev";
}

// The ONLY BrokerContext constructor for cookie/session (web console) paths. userId comes from
// the verified session; env from the env cookie; workspaceId from resolveWorkspace against the
// session's activeWorkspaceId. Invariant 8, restated for multi-membership: a caller may name a
// workspace it is a verified member of — the server intersects the named workspace with
// membership loaded at request time, and a workspace that is absent, unknown, or not a
// membership yields no context and no rows, never a default. Any env-like body param is ignored.
// MCP/OAuth paths use lib/broker-context.ts's deriveTokenContext; REST API paths use
// lib/rest-context.ts's deriveRestContext — three constructors, one per auth protocol boundary.
export async function deriveContext(req: Request): Promise<BrokerContext | null> {
  const data = await getSessionData(req);
  if (!data) return null;
  const workspaceId = await resolveWorkspace(getAppPool(), data.user.id, data.activeWorkspaceId);
  if (workspaceId === null) return null;
  return {
    userId: data.user.id,
    workspaceId,
    env: readEnvCookie(req),
    // No ceiling, stated rather than omitted. A collection ceiling belongs to a *client* — it is
    // read from the client policy in the other two constructors — and a browser session has no
    // client. What bounds a console user is their grants, which every verb loads anyway.
    allowedCollections: null,
    via: "session",
  };
}
