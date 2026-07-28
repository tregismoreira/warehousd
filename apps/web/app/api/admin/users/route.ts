import { NextRequest } from "next/server";
import { getAppPool } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";

export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;
  // Explicit column list: `select *` on Better Auth's user table would be one schema bump
  // away from returning credential material.
  const r = await getAppPool().query(`
    select u.id, u.email, u.name, u.role, u."createdAt",
           (select count(*) from app.grants g where g.user_id = u.id and g.status='approved')::int as "grantCount"
    from app."user" u order by u.role, u.email`);
  return Response.json({ users: r.rows });
}
