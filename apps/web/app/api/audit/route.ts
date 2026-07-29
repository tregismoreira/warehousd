import { NextRequest } from "next/server";
import { getAppPool } from "../../lib/broker";
import { requireSession } from "../../../lib/authz";
import { atLeast } from "../../../lib/authz";
import { orgOf } from "../../../lib/session";

const MAX_LIMIT = 200;

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if (!guard.ok) return guard.response;
  const url = new URL(req.url);
  const q = url.searchParams;

  const where: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, v: unknown) => { values.push(v); where.push(sql.replace("$?", `$${values.length}`)); };

  // Org first, and unconditionally: the audit trail names users, collections and purposes, so
  // an admin browsing it must never see another tenant's. This is the one filter no query
  // parameter can widen.
  add("org_id = $?", orgOf(guard.user));

  // Non-admins see their own trail and nothing else — a ?user= from them is ignored, not
  // honoured and not rejected, so the filter UI can stay identical across roles.
  if (atLeast(guard.user.role, "admin")) {
    const user = q.get("user");
    if (user) add("user_id = $?", user);
  } else {
    add("user_id = $?", guard.user.id);
  }

  const collection = q.get("collection");
  if (collection) add("collection = $?", collection);

  const outcome = q.get("outcome");
  if (outcome) {
    if (outcome !== "allowed" && outcome !== "refused")
      return Response.json({ error: "invalid_outcome" }, { status: 400 });
    add("outcome = $?", outcome);
  }

  const env = q.get("env");
  if (env) {
    if (env !== "dev" && env !== "live")
      return Response.json({ error: "invalid_env" }, { status: 400 });
    add("env = $?", env);
  }

  const reason = q.get("reason");
  if (reason) add("reason = $?", reason);

  const via = q.get("via");
  if (via) add("via = $?", via);

  const limit = Math.min(Math.max(Number(q.get("limit") ?? 50) || 50, 1), MAX_LIMIT);
  const offset = Math.max(Number(q.get("offset") ?? 0) || 0, 0);
  const clause = where.length ? `where ${where.join(" and ")}` : "";
  const app = getAppPool();

  const [rows, total] = await Promise.all([
    app.query(
      `select id, at, user_id, env, collection, intent, fields_returned, grant_id, outcome, reason, via
       from app.audit_events ${clause} order by at desc limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, limit, offset]),
    app.query(`select count(*)::int as n from app.audit_events ${clause}`, values),
  ]);

  return Response.json({ events: rows.rows, total: total.rows[0].n });
}
