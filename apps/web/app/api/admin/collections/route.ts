import { NextRequest } from "next/server";
import { countDocumentsIn } from "@warehousd/broker";
import { getBroker, getAppPool, getConfig } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";
import { readEnvCookie } from "../../../../lib/session";
import { applyStatus } from "../../../../lib/apply-status";

export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const cfg = getConfig();
  const r = await getAppPool().query(`select name, config, updated_at from app.collections`);
  const applied = new Map(r.rows.map((x) => [x.name as string, x]));

  const shaped = Object.entries(cfg.collections).map(([name, c]) => ({
    name,
    description: c.description,
    type: c.type ?? "dataset",
    taxonomies: c.taxonomies ?? [],
    status: applyStatus(c, applied.get(name)?.config ?? null),
    appliedAt: applied.get(name)?.updated_at ?? null,
    fields: Object.entries(c.fields).map(([fname, f]) => ({
      name: fname,
      type: f.type ?? null,
      posture: f.posture,
      pk: f.pk ?? false,
      fk: f.fk ?? null,
      view_join: f.view_join ?? null,
      nullable: f.nullable ?? false,
      searchable: f.searchable ?? false,
    })),
  }));

  const env = readEnvCookie(req);

  // Counting is opt-in, because it is the expensive half. `count(*)` over a collection's view is
  // a scan, and four surfaces read this endpoint — the overview, the audit browser's collection
  // filter, the import picker and the collections list. Only the last one shows a count, so only
  // it asks; the other three would otherwise pay for twenty scans they never render.
  //
  // Counts are for the console's current environment — the cookie the env switcher writes — and
  // for the admin's own workspace. A collection with nothing applied has no view to count, and that is
  // `null` rather than `0`: "never deployed here" and "deployed and empty" are different facts,
  // and an admin looking at a fresh environment needs to be able to tell them apart.
  if (new URL(req.url).searchParams.get("counts") !== "1")
    return Response.json({ env, collections: shaped });

  const counts = await countDocumentsIn(
    getBroker().pools,
    { env, workspaceId: guard.workspaceId },
    cfg,
    shaped.filter((c) => c.status !== "not_applied").map((c) => c.name),
  );

  return Response.json({
    env,
    collections: shaped.map((c) => ({ ...c, documentCount: counts[c.name] ?? null })),
  });
}
