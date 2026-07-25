import type { BrokerContext } from "@warehousd/broker";
import { auth } from "./auth";

// The ONLY place BrokerContext is constructed for token-authenticated (MCP/OAuth) paths.
// lib/session.ts's deriveContext remains the sole constructor for cookie/session paths — see
// the note there. Tokens carry only sub/client/env scope (§6.1); any env-like value in the
// request body/params is ignored and never read here.
export async function deriveTokenContext(req: Request): Promise<BrokerContext | null> {
  const session = await (auth as any).api.getMcpSession({ headers: req.headers });
  if (!session) return null;
  const scopes = (session.scopes ?? "").split(" ").filter(Boolean);
  const env = scopes.includes("env:live") ? "live" : "dev";
  return { userId: session.userId, env };
}
