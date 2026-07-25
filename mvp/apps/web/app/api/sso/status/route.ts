import { NextRequest } from "next/server";
import { getAppPool } from "../../../lib/broker";
import { LOCAL_LOGIN_DISABLED } from "../../../../lib/auth";

export async function GET(req: NextRequest) {
  const pool = getAppPool();
  const result = await pool.query(`
    select "providerId", domain, "samlConfig" from app."ssoProvider"
  `);

  const providers = result.rows.map((row: any) => ({
    providerId: row.providerId,
    domain: row.domain,
    type: row.samlConfig ? "saml" : "oidc",
  }));

  return Response.json({
    providers,
    localLoginEnabled: !LOCAL_LOGIN_DISABLED,
  });
}
