import { NextRequest } from "next/server";
import { mayManageWorkspace, regenerateSynthetic } from "@warehousd/broker";
import { getAppPool, getConfig } from "../../../../../lib/broker";
import {
  derivePlatformCaller,
  platformDisabled,
  platformUnauthenticated,
  platformAuditWriter,
} from "../../../../../../lib/platform-context";

type Ctx = { params: Promise<{ id: string }> };

function notManaged(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

// dev only — the literal, never a parameter. A platform key has no interactive holder to carry a
// live-grant eligibility check, and this route exists to give a freshly created tenant SOMETHING
// to look at, not to populate real data (that is the admin import path, unconditionally).
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await derivePlatformCaller(req);
  if (!auth.ok) return auth.reason === "disabled" ? platformDisabled() : platformUnauthenticated();
  const { id } = await ctx.params;
  if (!mayManageWorkspace(auth.caller, id)) return notManaged();

  const app = getAppPool();
  const cfg = getConfig();

  const exists = await app.query(`select 1 from app.workspaces where id=$1`, [id]);
  if (exists.rowCount === 0) return notManaged();

  const body: unknown = await req.json().catch(() => ({}));
  const { seed } = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  const seedValue = typeof seed === "number" && Number.isFinite(seed) ? seed : 42;

  const { collections } = await regenerateSynthetic(app, cfg, id, seedValue);

  const writer = platformAuditWriter(app, cfg, auth.caller.keyId, id);
  await writer.allow(null, { intent: { op: "workspace_seeded", id, seed: seedValue } });

  return Response.json({ ok: true, collections });
}
