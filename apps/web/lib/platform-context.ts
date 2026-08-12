import type { Pool } from "pg";
import {
  verifyPlatformKey,
  workspacesEnabled,
  makeAuditWriter,
  auditEnabled,
  auditDestination,
  type AuditWriter,
  type WarehousdConfig,
} from "@warehousd/broker";
import { getAppPool, getConfig } from "../app/lib/broker";

// The fourth and last auth boundary, after session cookies (lib/session.ts), MCP/OAuth tokens
// (lib/broker-context.ts) and REST tokens (lib/rest-context.ts). A platform key is a bearer
// secret for the provisioning API only — never a session, never an OAuth client.
//
// Returns a `PlatformCaller`, deliberately not a `BrokerContext`: there is no type-level path
// from a platform key to the data plane. Nothing in this file ever constructs a BrokerContext,
// and no /v1/collections or /mcp route reads through here — they resolve their caller through
// their own constructors, which never call verifyPlatformKey.
export type PlatformCaller = { keyId: string; label: string; managedWorkspaces: string[] | null };

export type PlatformAuthResult =
  { ok: true; caller: PlatformCaller } | { ok: false; reason: "disabled" | "unauthenticated" };

// Every route under apps/web/app/v1/platform/ calls this first, and only this — the flag check
// lives HERE, inside the one function every route must call to learn who is calling, so a route
// cannot forget it. `reason: "disabled"` and `reason: "unauthenticated"` are deliberately kept
// distinct in the return type even though both are refusals: a route must answer the first with a
// bare 404 (an unmounted API should look unmounted — not 403, and no body explaining the flag)
// and the second with 401. Collapsing them into one boolean would make the 404-when-off guarantee
// depend on every route remembering to check the flag again itself.
export async function derivePlatformCaller(req: Request): Promise<PlatformAuthResult> {
  if (!workspacesEnabled(getConfig())) return { ok: false, reason: "disabled" };

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return { ok: false, reason: "unauthenticated" };
  const secret = authHeader.slice("Bearer ".length).trim();
  if (!secret) return { ok: false, reason: "unauthenticated" };

  const key = await verifyPlatformKey(getAppPool(), secret);
  if (!key) return { ok: false, reason: "unauthenticated" };

  return {
    ok: true,
    caller: { keyId: key.id, label: key.label, managedWorkspaces: key.managedWorkspaces },
  };
}

// The response for `reason: "disabled"` — a body-less 404, so a probe against this namespace with
// workspaces.enabled: false cannot distinguish "not mounted" from "does not exist".
export function platformDisabled(): Response {
  return new Response(null, { status: 404 });
}

export function platformUnauthenticated(): Response {
  return Response.json({ error: "unauthenticated" }, { status: 401 });
}

// Every platform mutation writes one audit event through this — never a hand-written insert (the
// same rule apps/web/app/api/admin/regen-synth/route.ts follows for the console's own operational
// event). The BrokerContext built here is scaffolding for the writer alone: it is never returned
// and never reaches a broker verb, which is what "no type-level path from a platform key to the
// data plane" means in practice. `collection: null` on the caller's `allow`/`refuse` call is what
// marks this as an operational, not a data, decision — see the widened AuditWriter in
// packages/broker/src/audit/decision.ts.
export function platformAuditWriter(
  app: Pool,
  cfg: WarehousdConfig,
  keyId: string,
  targetWorkspaceId: string,
): AuditWriter {
  return makeAuditWriter(
    app,
    {
      userId: `platform:${keyId}`,
      workspaceId: targetWorkspaceId,
      env: "dev",
      allowedCollections: [],
      via: `platform_key:${keyId}`,
    },
    auditEnabled(cfg),
    auditDestination(cfg),
  );
}
