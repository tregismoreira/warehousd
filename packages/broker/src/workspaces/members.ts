import type { Pool, PoolClient } from "pg";

export const WORKSPACE_ROLES = ["admin", "manager", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export type WorkspaceMembership = { workspaceId: string; role: WorkspaceRole };

// Thrown by removeMember when the removal would leave a workspace with no admin — a workspace in
// that state cannot be repaired from the console, since every admin-only action (including
// re-adding an admin) needs an admin to perform it.
export class LastAdminRemoval extends Error {}

// The caller's role IN one workspace. null when they are not a member — which is the same answer
// as "no such workspace", deliberately: a non-member must not be able to probe for the existence
// of a tenant they do not belong to.
export async function memberRole(
  db: Pool | PoolClient,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const r = await db.query<{ role: WorkspaceRole }>(
    `select role from app.workspace_members where workspace_id = $1 and user_id = $2`,
    [workspaceId, userId],
  );
  return r.rows[0]?.role ?? null;
}

// Every workspace this user belongs to, workspace_id ascending for a stable switcher order.
export async function listMemberships(
  db: Pool | PoolClient,
  userId: string,
): Promise<WorkspaceMembership[]> {
  const r = await db.query<{ workspace_id: string; role: WorkspaceRole }>(
    `select workspace_id, role from app.workspace_members where user_id = $1 order by workspace_id`,
    [userId],
  );
  return r.rows.map((row) => ({ workspaceId: row.workspace_id, role: row.role }));
}

export async function setMember(
  db: Pool,
  i: { workspaceId: string; userId: string; role: WorkspaceRole },
): Promise<void> {
  await db.query(
    `insert into app.workspace_members (workspace_id, user_id, role)
     values ($1, $2, $3)
     on conflict (workspace_id, user_id) do update set role = $3`,
    [i.workspaceId, i.userId, i.role],
  );
}

// Refuses to remove the last admin of a workspace: the row survives and the error is thrown
// before any write. A workspace with no admin cannot be repaired from the console.
export async function removeMember(
  db: Pool,
  i: { workspaceId: string; userId: string },
): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const target = await client.query<{ role: WorkspaceRole }>(
      `select role from app.workspace_members where workspace_id = $1 and user_id = $2 for update`,
      [i.workspaceId, i.userId],
    );
    const role = target.rows[0]?.role;
    if (role === undefined) {
      await client.query("commit");
      return false;
    }
    if (role === "admin") {
      const admins = await client.query<{ n: string }>(
        `select count(*)::int as n from app.workspace_members
         where workspace_id = $1 and role = 'admin'`,
        [i.workspaceId],
      );
      if (Number(admins.rows[0]?.n ?? 0) <= 1) {
        await client.query("rollback");
        throw new LastAdminRemoval(`cannot remove the last admin of workspace ${i.workspaceId}`);
      }
    }
    await client.query(
      `delete from app.workspace_members where workspace_id = $1 and user_id = $2`,
      [i.workspaceId, i.userId],
    );
    await client.query("commit");
    return true;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function listMembers(
  db: Pool,
  workspaceId: string,
): Promise<
  { userId: string; email: string; name: string; role: WorkspaceRole; createdAt: string }[]
> {
  const r = await db.query<{
    user_id: string;
    email: string;
    name: string;
    role: WorkspaceRole;
    created_at: string;
  }>(
    `select m.user_id, u.email, u.name, m.role, m.created_at
     from app.workspace_members m
     join app."user" u on u.id = m.user_id
     where m.workspace_id = $1
     order by u.email`,
    [workspaceId],
  );
  return r.rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.created_at,
  }));
}
