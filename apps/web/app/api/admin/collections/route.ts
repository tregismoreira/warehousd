import { NextRequest } from "next/server";
import { getAppPool, getConfig } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";
import { applyStatus } from "../../../../lib/apply-status";

export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const cfg = getConfig();
  const r = await getAppPool().query(`select name, config, updated_at from app.collections`);
  const applied = new Map(r.rows.map((x) => [x.name as string, x]));

  return Response.json({
    collections: Object.entries(cfg.collections).map(([name, c]) => {
      const row = applied.get(name);
      return {
        name,
        description: c.description,
        type: c.type ?? "dataset",
        taxonomies: c.taxonomies ?? [],
        status: applyStatus(c, row?.config ?? null),
        appliedAt: row?.updated_at ?? null,
        fields: Object.entries(c.fields).map(([fname, f]) => ({
          name: fname,
          type: f.type ?? null,
          posture: f.posture,
          pk: f.pk ?? false,
          fk: f.fk ?? null,
          view_join: f.view_join ?? null,
          nullable: f.nullable ?? false,
        })),
      };
    }),
  });
}
