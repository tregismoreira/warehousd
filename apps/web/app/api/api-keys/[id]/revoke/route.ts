import { NextRequest } from "next/server";
import { revokeClientSecret } from "@warehousd/broker";
import { getAppPool } from "../../../../lib/broker";
import { requireRole } from "../../../../../lib/authz";
import { orgOf } from "../../../../../lib/session";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const clientId = (await params).id;
  const org = orgOf(guard.user);
  const { secretId } = await req.json();

  if (!secretId) {
    return Response.json({ error: "missing_secret_id" }, { status: 400 });
  }

  // revokeClientSecret takes the client and org and matches on all three, so ownership is
  // enforced by the update itself rather than by a check this route has to remember to do.
  const revoked = await revokeClientSecret(getAppPool(), secretId, clientId, org);
  if (!revoked) return Response.json({ error: "not_found" }, { status: 404 });

  return Response.json({ ok: true });
}
