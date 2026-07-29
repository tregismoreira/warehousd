import { NextRequest } from "next/server";
import { grantableFields } from "@warehousd/broker";
import { getAppPool, getConfig } from "../../../lib/broker";
import { requireSession } from "../../../../lib/authz";
import { readEnvCookie, orgOf } from "../../../../lib/session";

// Mirrors broker.listCollections' disclosure rule (§10 test 2): names + descriptions are
// public to any authenticated user, and so is the YAML allow-list, because a user must know
// what they can ask for. Row counts, schemas of denied fields and data never appear here.
export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if (!guard.ok) return guard.response;
  const env = readEnvCookie(req);
  const cfg = getConfig();
  const existing = await getAppPool().query(
    `select collection from app.grants
     where org_id=$3 and user_id=$1 and env=$2 and status in ('pending','approved')`,
    [guard.user.id, env, orgOf(guard.user)]);
  const taken = new Set(existing.rows.map((r) => r.collection));

  return Response.json({
    collections: Object.entries(cfg.collections).map(([name, c]) => ({
      name,
      description: c.description,
      type: c.type ?? "dataset",
      grantableFields: grantableFields(cfg, name),
      alreadyGranted: taken.has(name),
    })),
  });
}
