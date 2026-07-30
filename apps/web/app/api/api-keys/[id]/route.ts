import { NextRequest } from "next/server";
import { getAppPool } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";
import { orgOf } from "../../../../lib/session";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const clientId = (await params).id;
  const org = orgOf(guard.user);
  const { allowedCollections, secretId, expiresAt } = await req.json();

  const app = getAppPool();

  if (allowedCollections !== undefined) {
    await app.query(
      `update app.client_policies set allowed_collections=$1 where client_id=$2 and org_id=$3`,
      [allowedCollections, clientId, org],
    );
  }

  if (secretId && expiresAt) {
    // Scoped by client_id/org_id, not secretId alone — otherwise a caller could edit any
    // secret's expiry in any org by id, regardless of the clientId in the URL.
    await app.query(
      `update app.client_secrets set expires_at=$1 where id=$2 and client_id=$3 and org_id=$4`,
      [new Date(expiresAt), secretId, clientId, org],
    );
  }

  return Response.json({ ok: true });
}
