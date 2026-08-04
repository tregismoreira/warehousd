import { NextRequest } from "next/server";
import { getAppPool } from "../../../../lib/broker";
import { setAllowedScopes } from "@warehousd/broker";
import { requireRole } from "../../../../../lib/authz";
import { readJson } from "../../../../../lib/rest";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ clientId: string }> },
) {
  const guard = await requireRole(req, "manager");
  if (!guard.ok) return guard.response;
  const sessionUser = guard.user;
  const { clientId } = await params;
  const body = await readJson(req);
  if (!body.ok) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { action } = body.value;
  const scopes = action === "promote" ? ["env:dev", "env:live"] : ["env:dev"];
  await setAllowedScopes(getAppPool(), clientId, scopes, sessionUser.id);
  return Response.json({ ok: true });
}
