import { NextRequest } from "next/server";
import { getAppPool } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";
import { auth } from "../../../../lib/auth";

export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const pool = getAppPool();
  const result = await pool.query(`
    select "providerId", issuer, domain, "samlConfig" from app."ssoProvider"
  `);

  const providers = result.rows.map((row: any) => ({
    providerId: row.providerId,
    issuer: row.issuer,
    domain: row.domain,
    type: row.samlConfig ? "saml" : "oidc",
  }));

  return Response.json({ providers });
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  try {
    const body = await req.json();
    const response = await auth.api.registerSSOProvider({
      body,
      headers: req.headers,
    });
    return Response.json(response);
  } catch (error: any) {
    if (error?.statusCode) {
      return Response.json(
        { error: error.message || "registration failed" },
        { status: error.statusCode }
      );
    }
    return Response.json({ error: "internal server error" }, { status: 500 });
  }
}
