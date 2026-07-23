import type { BrokerContext } from "@warehousd/broker";
import { auth, type SessionUser } from "./auth";

export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const s = await auth.api.getSession({ headers: req.headers });
  if (!s?.user) return null;
  return s.user as SessionUser;
}

// Env is a session-scoped console value read ONLY from the signed cookie, never from
// the request body/params (SPECS §6.1 invariant). Default dev.
export function readEnvCookie(req: Request): "dev" | "live" {
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)wh_env=(dev|live)(?:;|$)/);
  return m?.[1] === "live" ? "live" : "dev";
}

// The ONLY place BrokerContext is constructed in the web console. userId comes from the
// verified session; env from the env cookie. Any env-like body param is ignored.
export async function deriveContext(req: Request): Promise<BrokerContext | null> {
  const user = await getSessionUser(req);
  if (!user) return null;
  return { userId: user.id, env: readEnvCookie(req) };
}
