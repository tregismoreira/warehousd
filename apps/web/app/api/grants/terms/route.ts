import { NextRequest } from "next/server";
import { findCollection, loadTaxonomyBindings } from "@warehousd/broker";
import { getAppPool, getConfig } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";
import { readEnvCookie } from "../../../../lib/session";

export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "manager");
  if (!guard.ok) return guard.response;

  const collection = req.nextUrl.searchParams.get("collection") ?? "";
  const cfg = getConfig();
  const c = findCollection(cfg, collection);
  if (!c || c.taxonomies.length === 0) return Response.json({ vocabularies: [] });

  const env = readEnvCookie(req) as "dev" | "live";
  const db = getAppPool();
  const bindings = await loadTaxonomyBindings(db, cfg, collection, env);

  return Response.json({
    vocabularies: bindings.map((b) => ({
      field: b.field,
      label: b.label,
      multiple: b.multiple,
      terms: b.slugs.map((slug) => {
        // Look up label from the vocabulary config
        const vocab = cfg.taxonomies[b.field];
        const label = vocab?.terms?.[slug]?.label ?? slug;
        return { slug, label };
      }),
    })),
  });
}
