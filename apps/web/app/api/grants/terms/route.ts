import { NextRequest } from "next/server";
import { findCollection } from "@warehousd/broker";
import { getConfig } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";

export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "manager");
  if (!guard.ok) return guard.response;

  const collection = req.nextUrl.searchParams.get("collection") ?? "";
  const cfg = getConfig();
  const c = findCollection(cfg, collection);
  if (!c?.taxonomy) return Response.json({ field: null, terms: [] });
  const vocab = cfg.taxonomies[c.taxonomy];
  return Response.json({
    field: c.taxonomy,
    terms: Object.entries(vocab?.terms ?? {}).map(([slug, t]) => ({ slug, label: t.label })),
  });
}
