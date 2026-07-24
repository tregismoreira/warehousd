import { NextRequest } from "next/server";
import { getAppPool } from "../../../../lib/broker";
import { setAllowedScopes } from "@warehousd/broker";
import { getSessionUser } from "../../../../../lib/session";

export async function POST(req: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const sessionUser = await getSessionUser(req);
  if (!sessionUser) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (sessionUser.role !== "manager" && sessionUser.role !== "admin") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const { clientId } = await params;
  const { action } = await req.json();
  const scopes = action === "promote" ? ["env:dev", "env:live"] : ["env:dev"];
  await setAllowedScopes(getAppPool(), clientId, scopes, sessionUser.id);
  return Response.json({ ok: true });
}
