import { NextRequest } from "next/server";
import { getAppPool } from "../../../../lib/broker";
import { setAllowedScopes, clientKeyEnvs } from "@warehousd/broker";
import { requireRole } from "../../../../../lib/authz";
import { readJson } from "../../../../../lib/rest";
import { orgOf } from "../../../../../lib/session";

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
  const app = getAppPool();

  // A promotion the client's own keys can never reach is refused rather than recorded.
  //
  // `env:live` on the policy is one of three gates; the key's `whd_dev_` / `whd_live_` prefix is
  // another, and it is fixed at mint time. Widening the policy for a client whose every usable key
  // is dev-prefixed changes nothing at all — but it writes `promoted_at`, and the console then
  // shows the client as live-capable. That reads as an escalation that happened, which is worse
  // than the no-op it actually is. Mint a live key instead; rotation deliberately will not do it.
  //
  // Demotion is never refused: narrowing is always meaningful and always safe.
  if (action === "promote") {
    const keys = await clientKeyEnvs(app, clientId, orgOf(sessionUser));
    if (keys.hasSecrets && !keys.liveCapable)
      return Response.json({ error: "no_live_capable_key" }, { status: 409 });
  }

  const scopes = action === "promote" ? ["env:dev", "env:live"] : ["env:dev"];
  await setAllowedScopes(app, clientId, scopes, sessionUser.id);
  return Response.json({ ok: true });
}
