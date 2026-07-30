import { NextRequest } from "next/server";
import { getAppPool } from "../../../../lib/broker";
import { getSessionUser } from "../../../../../lib/session";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  const sessionUser = await getSessionUser(req);
  if (!sessionUser) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (sessionUser.role !== "admin") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

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
    console.error("Error deleting SSO provider:", error);
    return Response.json({ error: "internal server error" }, { status: 500 });
  } finally {
    client.release();
  }
}
