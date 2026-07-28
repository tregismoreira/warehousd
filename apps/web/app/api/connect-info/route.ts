import { NextRequest } from "next/server";
import { getAppPool } from "../../lib/broker";
import { requireSession } from "../../../lib/authz";
import { LOCAL_LOGIN_DISABLED } from "../../../lib/auth";

// The base URL is the configured issuer, never a Host header — a connector URL derived from
// an attacker-controlled header would send users' OAuth flows somewhere else.
const BASE = process.env.BETTER_AUTH_URL ?? "http://localhost:8722";

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if (!guard.ok) return guard.response;
  const r = await getAppPool().query(
    `select "providerId", "samlConfig" from app."ssoProvider"`);
  return Response.json({
    mcpUrl: `${BASE}/mcp`,
    apiUrl: BASE,
    issuer: BASE,
    scopes: ["env:dev", "env:live"],
    ssoProviders: r.rows.map((x) => ({
      providerId: x.providerId, type: x.samlConfig ? "saml" : "oidc",
    })),
    localLoginEnabled: !LOCAL_LOGIN_DISABLED,
  });
}
