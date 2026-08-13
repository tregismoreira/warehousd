import { NextRequest } from "next/server";
import { countTermUsage } from "@warehousd/broker";
import { getBroker, getAppPool, getConfig } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";
import { readEnvCookie } from "../../../../lib/session";

// Every vocabulary in the configuration, with the terms that actually exist in this environment
// and how many documents carry each of them.
//
// Terms are read from app.terms rather than resolved from the YAML, because a dataset-sourced
// vocabulary has no YAML terms at all — its labels are columns of another collection, filled in
// by syncDatasetTerms. Resolving from config alone is what leaves a picker showing `c-0042`
// instead of a client's name.
//
// A YAML vocabulary's terms are stored under env 'all'; a dataset-sourced one is stored per
// environment, because the source rows differ between dev and live. Same rule as
// loadTaxonomyBindings, which is the other reader of these two tables.
export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const cfg = getConfig();
  const env = readEnvCookie(req);
  const workspaceId = guard.workspaceId;
  const app = getAppPool();

  const stored = new Map(
    (
      await app.query<{ id: string; slug: string }>(`select id, slug from app.vocabularies`)
    ).rows.map((r) => [r.slug, r.id]),
  );
  // Counting reads a collection's view, which exists only once something has been applied.
  const appliedCollections = new Set(
    (await app.query<{ name: string }>(`select name from app.collections`)).rows.map((r) => r.name),
  );

  const vocabularies = [];
  for (const [slug, vocab] of Object.entries(cfg.taxonomies)) {
    const collections = Object.entries(cfg.collections)
      .filter(([, c]) => (c.taxonomies ?? []).includes(slug))
      .map(([name]) => name);

    const vocabularyId = stored.get(slug);
    const termRows = vocabularyId
      ? (
          await app.query<{ slug: string; label: string | null }>(
            `select slug, label from app.terms
             where vocabulary_id=$1 and env=$2 and workspace_id in ('*', $3) order by slug`,
            [vocabularyId, vocab.terms ? "all" : env, workspaceId],
          )
        ).rows
      : [];

    // One count per bound collection, summed: a vocabulary's term is used by every collection
    // that binds it, and the per-collection breakdown belongs on the collection's own page.
    const usage: Record<string, number> = {};
    for (const collection of collections) {
      if (!appliedCollections.has(collection)) continue;
      try {
        const counts = await countTermUsage(
          getBroker().pools,
          { env, workspaceId },
          cfg,
          collection,
          slug,
        );
        for (const [term, n] of Object.entries(counts)) usage[term] = (usage[term] ?? 0) + n;
      } catch (err) {
        // The page's subject is the vocabulary, not any one collection: a collection whose view
        // is missing costs its share of the count, not the whole response.
        console.error("[admin] countTermUsage failed", { collection, vocabulary: slug, env, err });
      }
    }

    vocabularies.push({
      slug,
      label: vocab.label,
      multiple: vocab.multiple,
      source: vocab.source ?? null,
      // Declared in warehousd.yml but never applied — so it has no terms yet, which is a
      // different thing from a vocabulary whose terms are genuinely empty.
      applied: !!vocabularyId,
      collections,
      terms: termRows.map((t) => ({
        slug: t.slug,
        label: t.label ?? t.slug,
        documentCount: usage[t.slug] ?? 0,
      })),
    });
  }

  return Response.json({ env, vocabularies });
}
