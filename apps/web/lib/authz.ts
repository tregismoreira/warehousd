import { getSessionUser } from "./session";
import type { SessionUser } from "./auth";

export type Role = SessionUser["role"];

// admin ⊃ manager ⊃ member. A route gated at "manager" admits admins too — this mirrors
// the pre-existing `role !== "manager" && role !== "admin"` checks in the grants and
// client-promotion routes, which this helper replaces.
const RANK: Record<Role, number> = { member: 0, manager: 1, admin: 2 };

export function atLeast(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}

export type Guard = { ok: true; user: SessionUser } | { ok: false; response: Response };

// Authorization is enforced here, per route — never in a layout. A layout redirect is UX;
// this is the gate. Error bodies are byte-identical to the hand-rolled checks they replace
// ({error:"unauthenticated"} / {error:"forbidden"}) because existing tests assert on them.
export async function requireSession(req: Request): Promise<Guard> {
  const user = await getSessionUser(req);
  if (!user) {
    return { ok: false, response: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  }
  return { ok: true, user };
}

export async function requireRole(req: Request, required: Role): Promise<Guard> {
  const s = await requireSession(req);
  if (!s.ok) return s;
  if (!atLeast(s.user.role, required)) {
    return { ok: false, response: Response.json({ error: "forbidden" }, { status: 403 }) };
  }
  return s;
}
