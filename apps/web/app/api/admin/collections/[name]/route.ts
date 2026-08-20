import { NextRequest } from "next/server";
import {
  countDocumentsIn,
  countTermUsage,
  FILTER_OPS,
  fileMetadataFields,
  findCollection,
  loadTaxonomyBindings,
  type TaxonomyBinding,
  kindOf,
  isToMany,
} from "@warehousd/broker";
import { getBroker, getAppPool, getConfig } from "../../../../lib/broker";
import { requireRole } from "../../../../../lib/authz";
import { readEnvCookie } from "../../../../../lib/session";
import { applyStatus } from "../../../../../lib/apply-status";

// One collection, everything the console's detail page needs about it: the configured shape, how
// it stands against what was applied, what its bound vocabularies contain in this environment,
// and how much data is behind it.
//
// The caller's own grant is included, and only ever their own. The data browser needs it to
// distinguish "denied by posture, never grantable" from "grantable but not granted from
// "granted" — the distinction that makes deny-by-default legible instead of just restrictive —
// and /api/me/grants already returns the same rows to the same person.
export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const { name } = await params;
  const cfg = getConfig();
  const c = findCollection(cfg, name);
  if (!c) return Response.json({ error: "unknown_collection" }, { status: 404 });

  const env = readEnvCookie(req);
  const workspaceId = guard.workspaceId;
  const app = getAppPool();

  const appliedRow = (
    await app.query(`select config, updated_at from app.collections where name=$1`, [name])
  ).rows[0];
  const status = applyStatus(c, appliedRow?.config ?? null);

  const grantRow = (
    await app.query(
      `select id, status, allowed_fields, verbs, document_filter, expires_at
         from app.grants
        where workspace_id=$1 and user_id=$2 and collection=$3 and env=$4 and status='approved'
          and (expires_at is null or expires_at > now())
        order by requested_at desc limit 1`,
      [workspaceId, guard.user.id, name, env],
    )
  ).rows[0];

  // Everything below reads the environment's data. A collection the YAML declares but nothing has
  // applied to *this* environment has no view and no vocabulary rows — which is a state an admin
  // console exists to show, not one it should fail on. So the live half degrades to nulls and the
  // configured half is served regardless; `status` is what says why.
  let documentCount: number | null = null;
  let bindings: TaxonomyBinding[] | null = null;
  let termCounts: Record<string, Record<string, number>> = {};

  if (status !== "not_applied") {
    const scope = { env, workspaceId };
    try {
      documentCount = (await countDocumentsIn(getBroker().pools, scope, cfg, [name]))[name] ?? null;
      bindings = await loadTaxonomyBindings(app, cfg, name, env, workspaceId);
      termCounts = Object.fromEntries(
        await Promise.all(
          (c.taxonomies ?? []).map(
            async (slug) =>
              [slug, await countTermUsage(getBroker().pools, scope, cfg, name, slug)] as const,
          ),
        ),
      );
    } catch (err) {
      // Never surface a driver message — it names schemas and columns. The page still renders,
      // showing the configuration and an apply status that explains the gap.
      console.error("[admin] collection inventory failed", { collection: name, env, err });
    }
  }

  // Config is the fallback shape when the vocabularies have not been applied: the binding, its
  // cardinality and where its terms come from are all declared in warehousd.yml. Only the terms
  // themselves live in the database, so only they go missing.
  const taxonomies = (c.taxonomies ?? []).map((slug) => {
    const vocab = cfg.taxonomies[slug];
    const bound = bindings?.find((b) => b.field === slug);
    return {
      field: slug,
      label: vocab?.label ?? slug,
      multiple: vocab?.multiple ?? false,
      source: vocab?.source ?? null,
      applied: !!bound,
      terms: (bound?.terms ?? []).map((t) => ({
        slug: t.slug,
        label: t.label,
        documentCount: termCounts[slug]?.[t.slug] ?? 0,
      })),
    };
  });

  return Response.json({
    name,
    description: c.description,
    type: c.type ?? "dataset",
    writable: c.writable ?? false,
    // Whether this collection carries per-document ACLs at all. The detail page shows the ACL
    // editor only when it does — an editor on a collection with no `_acl` column would write rows
    // the read path never reads.
    acl: c.acl ?? false,
    status,
    appliedAt: appliedRow?.updated_at ?? null,
    env,
    documentCount,
    fields: Object.entries(c.fields).map(([fname, f]) => ({
      name: fname,
      type: f.type ?? null,
      posture: f.posture,
      pk: f.pk ?? false,
      fk: f.fk ?? null,
      view_join: f.view_join ?? null,
      relation: f.relation
        ? {
            collection: f.relation.collection,
            on: isToMany(f.relation) ? null : f.relation.on,
            fields: Object.keys(f.relation.select),
          }
        : null,
      nullable: f.nullable ?? false,
      searchable: f.searchable ?? false,
    })),
    taxonomies,
    // The typed extra fields a file collection carries, as the broker computes them. Same reason
    // as `filterOps` below: the upload form needs to render an input per metadata field, and
    // deciding which of `fields` those are means knowing which names are structural — a list the
    // client would otherwise have to keep in step with the broker's by hand.
    metadataFields: kindOf(c).chunked ? fileMetadataFields(c) : [],
    // The operators the broker's intent schema accepts, served rather than restated. The data
    // browser is a client component, and importing the broker into the browser bundle would drag
    // `pg` and `node:fs` in with it — so the one place that knows the list hands it over.
    filterOps: FILTER_OPS,
    grant: grantRow
      ? {
          id: grantRow.id as string,
          allowedFields: (grantRow.allowed_fields ?? []) as string[],
          verbs: (grantRow.verbs ?? ["read"]) as string[],
          documentFilter: grantRow.document_filter ?? null,
          expiresAt: grantRow.expires_at ?? null,
        }
      : null,
  });
}
