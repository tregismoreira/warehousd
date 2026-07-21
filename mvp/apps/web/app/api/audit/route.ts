import { getAppPool } from "../../lib/broker";
export async function GET() {
  const r = await getAppPool().query(
    `select id, at, user_id, env, collection, intent, fields_returned, outcome, reason
     from app.audit_events order by at desc limit 50`);
  return Response.json(r.rows);
}
