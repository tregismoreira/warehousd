import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { mayManageWorkspace, upsertClientPolicy, createClientSecret } from "@warehousd/broker";
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

const DEFAULT_CLIENT_KEY_DAYS = 90;

// Provisions an OAuth client pinned to this workspace and mints its first secret, in one call —
// the platform API's counterpart to the console's "new client" flow, for a caller with no console
// to click through.
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await derivePlatformCaller(req);
  if (!auth.ok) return auth.reason === "disabled" ? platformDisabled() : platformUnauthenticated();
  const { id } = await ctx.params;
  if (!mayManageWorkspace(auth.caller, id)) return notManaged();

  const app = getAppPool();
  const exists = await app.query(`select 1 from app.workspaces where id=$1`, [id]);
  if (exists.rowCount === 0) return notManaged();

  const body: unknown = await req.json().catch(() => ({}));
  const { displayName, env, days } = (
    typeof body === "object" && body !== null ? body : {}
  ) as Record<string, unknown>;
  const clientEnv = env === "live" ? "live" : "dev";
  const lifetimeDays =
    typeof days === "number" && Number.isFinite(days) && days > 0 ? days : DEFAULT_CLIENT_KEY_DAYS;
  const expiresAt = new Date(Date.now() + lifetimeDays * 24 * 60 * 60 * 1000);

  const clientId = randomBytes(16).toString("hex");
  await upsertClientPolicy(
    app,
    clientId,
    typeof displayName === "string" ? displayName : null,
    [`env:${clientEnv}`],
    id,
  );
  const { secret, id: secretId } = await createClientSecret(
    app,
    clientId,
    id,
    expiresAt,
    `platform:${auth.caller.keyId}`,
    clientEnv,
  );

  const cfg = getConfig();
  const writer = platformAuditWriter(app, cfg, auth.caller.keyId, id);
  await writer.allow(null, {
    intent: { op: "platform_client_created", id, clientId, env: clientEnv },
  });

  return Response.json({ clientId, secretId, secret, env: clientEnv }, { status: 201 });
}
