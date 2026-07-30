import { NextRequest } from "next/server";
import { getAppPool } from "../../../lib/broker";
import { LOCAL_LOGIN_DISABLED } from "../../../../lib/auth";

// Deliberately unauthenticated: the login page has no session yet and needs to know which
// buttons to render. It is therefore the one place where what is *not* selected matters.
//
// `domain` used to be returned here. Nothing consumes it — the login form uses `providerId` and
// `type` to build the sign-in buttons, and the admin page reads domains from the admin-only
// /api/sso/providers — so it was publishing the customer email domains of every configured
// provider to anonymous callers for no purpose. That is enumeration material for a phishing
// campaign: it names the organisations using the deployment.
//
// Not scoped by org, because there is no session to scope it to and one deployment is currently
// one organization (see SECURITY.md, "No multi-tenancy"). When a deployment can hold more than
// one, this endpoint has to key on the request host or take an explicit hint — returning a
// union across tenants would leak the tenant list.
export async function GET(_req: NextRequest) {
  const pool = getAppPool();
  const result = await pool.query(`
    select "providerId", "samlConfig" from app."ssoProvider"
  `);

  const providers = result.rows.map((row: { providerId: string; samlConfig: unknown }) => ({
    providerId: row.providerId,
    type: row.samlConfig ? "saml" : "oidc",
  }));

  return Response.json({
    providers,
    localLoginEnabled: !LOCAL_LOGIN_DISABLED,
  });
}
