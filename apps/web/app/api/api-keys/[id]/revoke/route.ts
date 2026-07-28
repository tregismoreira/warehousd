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

  const app = getAppPool();
  // Verify the secret actually belongs to this client/org before revoking — otherwise a
  // caller could revoke any secret in any org by id alone, since revokeClientSecret itself
  // takes only a secretId.
  const owned = await app.query(
    `select 1 from app.client_secrets where id=$1 and client_id=$2 and org_id=$3`,
    [secretId, clientId, org]);
  if (owned.rowCount === 0) return Response.json({ error: "not_found" }, { status: 404 });

  await revokeClientSecret(app, secretId);

  return Response.json({ ok: true });
}
