import { NextRequest } from "next/server";
import { loadConfig } from "@warehousd/broker";

const projectDir = process.env.WAREHOUSD_PROJECT_DIR!;

export async function GET(req: NextRequest) {
  const collection = req.nextUrl.searchParams.get("collection") ?? "";
  const cfg = loadConfig(projectDir);
  const c = cfg.collections[collection];
  if (!c?.taxonomy) return Response.json({ field: null, terms: [] });
  const vocab = cfg.taxonomies[c.taxonomy];
  return Response.json({
    field: c.taxonomy,
    terms: Object.entries(vocab?.terms ?? {}).map(([slug, t]) => ({ slug, label: t.label })),
  });
}
