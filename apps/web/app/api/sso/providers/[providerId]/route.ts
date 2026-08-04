import { NextRequest } from "next/server";
import { getAppPool } from "../../../../lib/broker";
import { requireRole } from "../../../../../lib/authz";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const { providerId } = await params;
  const pool = getAppPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`delete from app."account" where "providerId" = $1`, [providerId]);
    await client.query(`delete from app."ssoProvider" where "providerId" = $1`, [providerId]);
    await client.query("COMMIT");
    return Response.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[web] sso provider delete failed", { providerId, error });
    return Response.json({ error: "internal_error" }, { status: 500 });
  } finally {
    client.release();
  }
}
