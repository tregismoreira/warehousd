import { memberRole } from "@warehousd/broker";
import { getSessionData } from "./session";
import { resolveWorkspace } from "./workspace-scope";
import type { SessionUser } from "./auth";
import { getAppPool } from "../app/lib/broker";

export type Role = SessionUser["role"];

// admin ⊃ manager ⊃ member. A route gated at "manager" admits admins too — this mirrors
// the pre-existing `role !== "manager" && role !== "admin"` checks in the grants and
// client-promotion routes, which this helper replaces.
const RANK: Record<Role, number> = { member: 0, manager: 1, admin: 2 };

export function atLeast(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}

export type Guard =
  | { ok: true; user: SessionUser; workspaceId: string; role: Role }
  | { ok: false; response: Response };

// Authorization is enforced here, per route — never in a layout. A layout redirect is UX;
// this is the gate. Error bodies are byte-identical to the hand-rolled checks they replace
// ({error:"unauthenticated"} / {error:"forbidden"}) because existing tests assert on them.
//
// The role on the guard comes from membership in the ACTIVE workspace, never from the
// account-level role column — an admin in one workspace is not necessarily an admin in another. No
// membership is a 403, not a 401: the caller is authenticated, just not in this workspace,
// and the two must read differently or a caller cannot tell "log in again" from "wrong
// workspace, try switching."
//
// The workspace itself comes from resolveWorkspace against the session's activeWorkspaceId
// (lib/workspace-scope.ts) — the same resolver the other two auth boundaries use, so the
// cookie boundary cannot drift from what deriveContext (lib/session.ts) resolves for the
// identical session.
export async function requireSession(req: Request): Promise<Guard> {
  const data = await getSessionData(req);
  if (!data) {
    return { ok: false, response: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  }
  const pool = getAppPool();
  const workspaceId = await resolveWorkspace(pool, data.user.id, data.activeWorkspaceId);
  if (workspaceId === null) {
    return { ok: false, response: Response.json({ error: "forbidden" }, { status: 403 }) };
  }
  const role = await memberRole(pool, workspaceId, data.user.id);
  if (role === null) {
    return { ok: false, response: Response.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { ok: true, user: data.user, workspaceId, role };
}

export async function requireRole(req: Request, required: Role): Promise<Guard> {
  const s = await requireSession(req);
  if (!s.ok) return s;
  if (!atLeast(s.role, required)) {
    return { ok: false, response: Response.json({ error: "forbidden" }, { status: 403 }) };
  }
  return s;
}
