import { NextRequest } from "next/server";
import { getAppPool } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";
import { readJson } from "../../../../lib/rest";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const clientId = (await params).id;
  const workspace = guard.workspaceId;
  const body = await readJson(req);
  if (!body.ok) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { allowedCollections, secretId, expiresAt } = body.value as {
    allowedCollections?: string[];
    secretId?: string;
    expiresAt?: string;
  };

  const app = getAppPool();

  if (allowedCollections !== undefined) {
    await app.query(
      `update app.client_policies set allowed_collections=$1 where client_id=$2 and workspace_id=$3`,
      [allowedCollections, clientId, workspace],
    );
  }

  if (secretId && expiresAt) {
    // Scoped by client_id/workspace_id, not secretId alone — otherwise a caller could edit any
    // secret's expiry in any workspace by id, regardless of the clientId in the URL.
    await app.query(
      `update app.client_secrets set expires_at=$1 where id=$2 and client_id=$3 and workspace_id=$4`,
      [new Date(expiresAt), secretId, clientId, workspace],
    );
  }

  return Response.json({ ok: true });
}
