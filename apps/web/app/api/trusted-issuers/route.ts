import { NextRequest } from "next/server";
import { listTrustedIssuers, createTrustedIssuer } from "@warehousd/broker";
import { getAppPool } from "../../lib/broker";
import { requireRole } from "../../../lib/authz";
import { readJson } from "../../../lib/rest";
import { orgOf } from "../../../lib/session";

export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const org = orgOf(guard.user);
  const app = getAppPool();
  const issuers = await listTrustedIssuers(app, org);

  return Response.json({ issuers });
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const org = orgOf(guard.user);
  const body = await readJson(req);
  if (!body.ok) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { issuer, jwksUri, audience, subjectClaim } = body.value as {
    issuer?: string;
    jwksUri?: string;
    audience?: string;
    subjectClaim?: string;
  };

  if (!issuer || !jwksUri || !audience) {
    return Response.json({ error: "missing_required_fields" }, { status: 400 });
  }

  const app = getAppPool();
  const created = await createTrustedIssuer(
    app,
    org,
    issuer,
    jwksUri,
    audience,
    subjectClaim || "sub",
  );

  return Response.json({ issuer: created }, { status: 201 });
}
