import { NextRequest } from "next/server";
import { getAppPool } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";
import { readJson } from "../../../../lib/rest";
import { auth } from "../../../../lib/auth";

export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const pool = getAppPool();
  const result = await pool.query<{
    providerId: string;
    issuer: string;
    domain: string;
    samlConfig: unknown;
  }>(`
    select "providerId", issuer, domain, "samlConfig" from app."ssoProvider"
  `);

  const providers = result.rows.map((row) => ({
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

  // Checked on a clone, ahead of the try. An unparseable body used to land in the catch below
  // and come back as a 500 — the caller sent something the parser could not read and was told
  // the server had broken.
  //
  // Only the parse is checked here, never the shape: registerSSOProvider validates that against
  // its own zod schema and throws an APIError carrying the status and message it wants returned,
  // which the catch passes through. Restating that schema would be a second, drifting answer to
  // "which fields are required" — so the request itself, not a re-serialised copy, is what gets
  // handed on.
  if (!(await readJson(req.clone())).ok)
    return Response.json({ error: "invalid_body" }, { status: 400 });

  try {
    const body = await req.json();
    const response = await auth.api.registerSSOProvider({
      body,
      headers: req.headers,
    });
    return Response.json(response);
  } catch (error) {
    // Better Auth's APIError carries the status it wants returned; anything else is ours.
    const e = error as { statusCode?: number; message?: string };
    if (e?.statusCode) {
      return Response.json({ error: e.message || "registration failed" }, { status: e.statusCode });
    }
    console.error("[web] sso provider registration failed", { error });
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}
