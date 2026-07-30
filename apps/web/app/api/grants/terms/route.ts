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

  const env = readEnvCookie(req);
  const db = getAppPool();
  const bindings = await loadTaxonomyBindings(db, cfg, collection, env);

  return Response.json({
    vocabularies: bindings.map((b) => ({
      field: b.field,
      label: b.label,
      multiple: b.multiple,
      // Labels come from app.terms, which applyConfig fills from the YAML and syncDatasetTerms
      // fills from the source collection's rows. Resolving them from config instead would leave
      // a dataset-sourced vocabulary showing raw `c-0042` slugs, since it has no YAML terms.
      terms: b.terms,
    })),
  });
}
