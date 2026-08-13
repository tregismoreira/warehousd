import { NextRequest } from "next/server";
import { getAppPool, getConfig } from "../../../lib/broker";
import { requireSession } from "../../../../lib/authz";

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if (!guard.ok) return guard.response;
  // user_id comes from the verified session — a ?user= param is never read.
  const cfg = getConfig();
  const r = await getAppPool().query(
    `select * from app.grants where workspace_id=$2 and user_id=$1 order by requested_at desc`,
    [guard.user.id, guard.workspaceId],
  );

  const now = Date.now();
  const grants = r.rows.map((g) => {
    const expired =
      g.status === "approved" && g.expires_at !== null && new Date(g.expires_at).getTime() <= now;
    const c = cfg.collections[g.collection];
    return {
      ...g,
      // The broker refuses an expired grant with no_grant; the UI must say so rather than
      // showing a green "Approved" the user cannot actually use.
      effectiveStatus: expired ? "expired" : g.status,
      collectionType: c?.type ?? "dataset",
      taxonomyFields: c?.taxonomies ?? [],
    };
  });
  return Response.json({ grants });
}
