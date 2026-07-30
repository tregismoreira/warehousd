import { NextRequest } from "next/server";
import { rotateClientSecret } from "@warehousd/broker";
import { getAppPool } from "../../../../lib/broker";
import { requireRole } from "../../../../../lib/authz";
import { orgOf } from "../../../../../lib/session";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const clientId = (await params).id;
  const org = orgOf(guard.user);
  const { oldSecretId, expiresAt } = await req.json();

  if (!oldSecretId) {
    return Response.json({ error: "missing_old_secret_id" }, { status: 400 });
  }

  const app = getAppPool();
  const expiryDate = expiresAt
    ? new Date(expiresAt)
    : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  try {
    const { secret, id } = await rotateClientSecret(
      app,
      clientId,
      org,
      oldSecretId,
      expiryDate,
      guard.user.id,
      "dev",
    );
    return Response.json({ secret, id }, { status: 201 });
  } catch {
    // rotateClientSecret throws on: old secret not found/revoked, or expiry exceeding
    // MAX_KEY_LIFETIME_DAYS — both are client errors, not server faults.
    return Response.json({ error: "invalid_rotation" }, { status: 400 });
  }
}
