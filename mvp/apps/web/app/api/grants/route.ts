import { NextRequest } from "next/server";
import { getAppPool } from "../../lib/broker";
import { approveGrant, denyGrant, revokeGrant, loadConfig } from "@warehousd/broker";
import { join } from "node:path";

const projectDir = process.env.WAREHOUSD_PROJECT_DIR!;

export async function GET(req: NextRequest) {
  const user = req.nextUrl.searchParams.get("user") ?? "";
  const app = getAppPool();
  const cfg = loadConfig(projectDir);
  const mine = await app.query(`select * from app.grants where user_id=$1 order by requested_at desc`, [user]);
  const pending = await app.query(`select * from app.grants where status='pending' order by requested_at desc`);

  // Enrich grants with collection type info
  const enriched = (rows: typeof mine.rows) => rows.map(g => ({
    ...g,
    collectionType: cfg.collections[g.collection]?.type || "structured",
  }));

  return Response.json({ mine: enriched(mine.rows), pending: enriched(pending.rows) });
}

export async function POST(req: NextRequest) {
  const { action, id, by, allowedFields, selectedPaths, expiresAt } = await req.json();
  const app = getAppPool();
  if (action === "approve") {
    const opts: any = { allowedFields, expiresAt };
    if (selectedPaths && selectedPaths.length > 0) {
      opts.rowFilter = { field: "path", op: "in", value: selectedPaths };
    }
    await approveGrant(app, id, by, opts);
  } else if (action === "deny") await denyGrant(app, id, by);
  else if (action === "revoke") await revokeGrant(app, id, by);
  return Response.json({ ok: true });
}
