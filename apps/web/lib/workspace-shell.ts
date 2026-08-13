import { listMemberships, workspacesEnabled } from "@warehousd/broker";
import { getAppPool, getConfig } from "../app/lib/broker";

export type WorkspaceMembershipView = { workspaceId: string; name: string; role: string };

export type WorkspaceShellData = {
  activeWorkspaceId: string;
  activeWorkspaceName: string;
  memberships: WorkspaceMembershipView[];
  // The raw config flag — gates surfaces that must exist regardless of how many workspaces THIS
  // caller belongs to, like the admin/members nav item and page (an admin managing their one
  // workspace's membership needs it before anyone has a second membership at all).
  workspacesFeatureEnabled: boolean;
  // Both conditions, not just membership count: a single-workspace deployment already has
  // count === 1 with the flag off, but the gate is explicit here too, so the switcher does not
  // reappear the day something inserts a second membership row by hand without the platform API
  // ever having been turned on. See plan §6, the paragraph on this being incidental vs explicit.
  switcherEnabled: boolean;
};

// Every console layout (member/manager/admin) calls this once, server-side, to learn what to
// show in the header: the active workspace's name — always — and the switcher's contents, when
// it may render at all. One function so the three layouts cannot compute this differently.
export async function workspaceShellData(
  userId: string,
  activeWorkspaceId: string,
): Promise<WorkspaceShellData> {
  const pool = getAppPool();
  const memberships = await listMemberships(pool, userId);
  const ids = memberships.map((m) => m.workspaceId);
  const rows = ids.length
    ? await pool.query<{ id: string; name: string }>(
        `select id, name from app.workspaces where id = any($1)`,
        [ids],
      )
    : { rows: [] as { id: string; name: string }[] };
  const nameOf = new Map(rows.rows.map((r) => [r.id, r.name]));
  const featureEnabled = workspacesEnabled(getConfig());

  return {
    activeWorkspaceId,
    activeWorkspaceName: nameOf.get(activeWorkspaceId) ?? activeWorkspaceId,
    memberships: memberships.map((m) => ({
      workspaceId: m.workspaceId,
      name: nameOf.get(m.workspaceId) ?? m.workspaceId,
      role: m.role,
    })),
    workspacesFeatureEnabled: featureEnabled,
    switcherEnabled: featureEnabled && memberships.length > 1,
  };
}
