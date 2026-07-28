import { NextRequest } from "next/server";
import { getAppPool } from "../../../../lib/broker";
import { setAllowedScopes } from "@warehousd/broker";
import { requireRole } from "../../../../../lib/authz";

export async function POST(req: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const guard = await requireRole(req, "manager");
  if (!guard.ok) return guard.response;
  const sessionUser = guard.user;
  const { clientId } = await params;
  const { action } = await req.json();
  const scopes = action === "promote" ? ["env:dev", "env:live"] : ["env:dev"];
  await setAllowedScopes(getAppPool(), clientId, scopes, sessionUser.id);
  return Response.json({ ok: true });
}
