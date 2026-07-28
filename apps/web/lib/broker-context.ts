import type { BrokerContext } from "@warehousd/broker";
import { DEFAULT_ORG_ID } from "@warehousd/broker";
import { auth } from "./auth";
import { getAppPool } from "../app/lib/broker";

// The ONLY place BrokerContext is constructed for token-authenticated (MCP/OAuth) paths.
// lib/session.ts's deriveContext remains the sole constructor for cookie/session paths — see
// the note there. Tokens carry only sub/client/env scope (§6.1); any env-like value in the
// request body/params is ignored and never read here.
//
// orgId obeys the identical rule as env: it is read from the token subject's user row, never
// from the request. A token cannot name its own tenant any more than it can name its own
// environment. The MCP session carries no org claim, so this is a lookup, not a cast.
export async function deriveTokenContext(req: Request): Promise<BrokerContext | null> {
  const session = await auth.api.getMcpSession({ headers: req.headers });
  if (!session) return null;
  const scopes = (session.scopes ?? "").split(" ").filter(Boolean);
  const env = scopes.includes("env:live") ? "live" : "dev";
  const r = await getAppPool().query(`select "orgId" from app."user" where id=$1`, [session.userId]);
  return { userId: session.userId, orgId: r.rows[0]?.orgId ?? DEFAULT_ORG_ID, env };
}
