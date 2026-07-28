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
//
// allowedCollections carries the client's collection ceiling — the intersection of the user's
// grants with the policy-defined collection restrictions. null = no ceiling (all collections allowed).
export async function deriveTokenContext(req: Request): Promise<BrokerContext | null> {
  const session = await auth.api.getMcpSession({ headers: req.headers });
  if (!session) return null;
  const scopes = (session.scopes ?? "").split(" ").filter(Boolean);
  const env = scopes.includes("env:live") ? "live" : "dev";
  const pool = getAppPool();
  const r = await pool.query(`select "orgId" from app."user" where id=$1`, [session.userId]);
  const orgId = r.rows[0]?.orgId ?? DEFAULT_ORG_ID;

  // Load client policy to get the collection ceiling
  const cp = await pool.query(
    `select allowed_collections from app.client_policies where client_id=$1`,
    [session.clientId || ""]);
  const allowedCollections = cp.rows[0]?.allowed_collections ?? null;

  return {
    userId: session.userId,
    orgId,
    env,
    allowedCollections,
    via: "oauth",
  };
}
