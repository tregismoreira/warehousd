import type { BrokerContext } from "@warehousd/broker";
import { DEFAULT_ORG_ID } from "@warehousd/broker";
import { auth, type SessionUser } from "./auth";

export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const s = await auth.api.getSession({ headers: req.headers });
  if (!s?.user) return null;
  return s.user as SessionUser;
}

// The org a session acts in. Control-plane routes read app.grants / app.audit_events /
// app.client_policies directly rather than through the broker, so each one has to carry the
// org predicate itself — there is no view or RLS policy standing behind them the way there is
// on the data plane. Every such query scopes by this.
export function orgOf(user: SessionUser): string {
  return user.orgId ?? DEFAULT_ORG_ID;
}

// Env is a session-scoped console value read ONLY from the signed cookie, never from
// the request body/params (see docs/architecture.md). Default dev.
export function readEnvCookie(req: Request): "dev" | "live" {
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)wh_env=(dev|live)(?:;|$)/);
  return m?.[1] === "live" ? "live" : "dev";
}

// The ONLY BrokerContext constructor for cookie/session (web console) paths. userId comes
// from the verified session; env from the env cookie; orgId from the session user (Better Auth).
// Any env-like body param is ignored. MCP/OAuth paths use lib/broker-context.ts's
// deriveTokenContext; REST API paths use lib/rest-context.ts's deriveRestContext — three
// constructors, one per auth protocol boundary.
export async function deriveContext(req: Request): Promise<BrokerContext | null> {
  const user = await getSessionUser(req);
  if (!user) return null;
  return {
    userId: user.id,
    orgId: user.orgId ?? DEFAULT_ORG_ID,
    env: readEnvCookie(req),
    // No ceiling, stated rather than omitted. A collection ceiling belongs to a *client* — it is
    // read from the client policy in the other two constructors — and a browser session has no
    // client. What bounds a console user is their grants, which every verb loads anyway.
    allowedCollections: null,
    via: "session",
  };
}
