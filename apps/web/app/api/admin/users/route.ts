import { NextRequest } from "next/server";
import { getAppPool } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";

export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;
  // Membership in the active workspace, not the account's home workspace and role — a user
  // added as a member of this workspace from elsewhere must show up here, with THIS workspace's
  // role, and a user who happens to be `workspaceId`-homed here but was never made a member must not.
  // Explicit column list: `select *` on Better Auth's user table would be one schema bump away
  // from returning credential material.
  const r = await getAppPool().query(
    `
    select u.id, u.email, u.name, m.role, u."createdAt",
           (select count(*) from app.grants g
             where g.workspace_id = $1 and g.user_id = u.id and g.status='approved')::int as "grantCount"
    from app.workspace_members m
    join app."user" u on u.id = m.user_id
    where m.workspace_id = $1 order by m.role, u.email`,
    [guard.workspaceId],
  );
  return Response.json({ users: r.rows });
}
