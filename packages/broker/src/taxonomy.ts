import type { Pool } from "pg";
import type { WarehousdConfig } from "./config/schema";

// Identifier shape shared with config/schema.ts — anything interpolated into SQL must match.
const IDENT = /^[a-z_][a-z0-9_]*$/i;

/**
 * Taxonomy binding loaded from the database for a specific environment.
 */
export type TaxonomyBinding = {
  field: string;
  label: string;
  multiple: boolean;
  /** Term slugs, in sort order. Convenience view of `terms` for validation and error messages. */
  slugs: string[];
  /**
   * Terms with their display labels. A dataset-sourced vocabulary's labels live only here —
   * they are columns of the source collection, not literals in the YAML — so a picker that
   * resolves labels from config alone can only show raw slugs.
   */
  terms: { slug: string; label: string }[];
};

/**
 * Syncs dataset-sourced vocabulary terms for a given environment.
 * Reads `select distinct <slug>, <label> from data_<schema>.<collection>`
 * and upserts terms into app.terms with the given env.
 *
 * Called after data exists (after generateSynthetic or seedLive) and before indexing.
 */
export async function syncDatasetTerms(db: Pool, cfg: WarehousdConfig, env: "dev" | "live"): Promise<void> {
  const schema = env === "dev" ? "data_synth" : "data_live";

  for (const [vocabSlug, vocab] of Object.entries(cfg.taxonomies ?? {})) {
    if (!vocab.source) continue; // Skip YAML-sourced vocabularies

    const srcCollection = cfg.collections[vocab.source.collection];
    if (!srcCollection || srcCollection.type !== "dataset") continue;

    // Get or create vocabulary
    const vid = (await db.query(
      `insert into app.vocabularies (slug, label) values ($1,$2)
       on conflict (slug) do update set label=excluded.label returning id`,
      [vocabSlug, vocab.label])).rows[0].id;

    // Slugify and upsert terms from the dataset. Every interpolated identifier is re-checked
    // here rather than trusted: ConfigSchema proves these name real fields on a real collection,
    // but that guarantee is transitive, and this is the one place a vocabulary's own strings
    // reach SQL. See sql/build.ts for the same discipline on the query side.
    const src = vocab.source;
    for (const id of [src.collection, src.slug, src.label])
      if (!IDENT.test(id)) throw new Error(`vocabulary "${vocabSlug}": unsafe identifier "${id}"`);

    const rows = (await db.query(
      `select distinct "${src.slug}" as slug, "${src.label}" as label
       from ${schema}."${src.collection}" where "${src.slug}" is not null`)).rows;

    // Two source rows can slugify to the same term ("Acme, Inc." and "Acme Inc" both give
    // `acme-inc`), and the upsert would quietly fold them into one — which silently widens
    // every grant scoped to that term. Refuse instead; the config author picks a better slug
    // field. Same for a value with nothing slug-safe in it at all.
    const seen = new Map<string, string>();
    for (const row of rows) {
      const slug = slugify(row.slug);
      if (!slug)
        throw new Error(`vocabulary "${vocabSlug}": ${src.collection}.${src.slug} value `
          + `"${row.slug}" has no slug-safe characters`);
      const clash = seen.get(slug);
      if (clash !== undefined && clash !== row.slug)
        throw new Error(`vocabulary "${vocabSlug}": ${src.collection}.${src.slug} values `
          + `"${clash}" and "${row.slug}" both slugify to "${slug}"`);
      seen.set(slug, row.slug);
      await db.query(
        `insert into app.terms (vocabulary_id, env, slug, label) values ($1,$2,$3,$4)
         on conflict (vocabulary_id, env, slug) do update set label=excluded.label`,
        [vid, env, slug, row.label]);
    }
  }
}

/**
 * Loads taxonomy bindings for a collection from the database.
 * Returns one entry per bound vocabulary, with slugs from app.terms for the given env.
 */
export async function loadTaxonomyBindings(
  db: Pool, cfg: WarehousdConfig, collection: string, env: "dev" | "live",
): Promise<TaxonomyBinding[]> {
  const c = cfg.collections[collection];
  if (!c) throw new Error(`Unknown collection: ${collection}`);

  const bindings: TaxonomyBinding[] = [];

  for (const vocabSlug of c.taxonomies ?? []) {
    const vocab = cfg.taxonomies[vocabSlug];
    if (!vocab) throw new Error(`Unknown vocabulary: ${vocabSlug}`);

    // Get vocabulary ID
    const vidRow = (await db.query(
      `select id from app.vocabularies where slug=$1`,
      [vocabSlug])).rows[0];

    if (!vidRow) throw new Error(`Vocabulary not found in database: ${vocabSlug}`);

    // Load terms for this env
    // YAML vocabularies have env='all', dataset-sourced have env='dev' or 'live'
    const termEnv = vocab.terms ? 'all' : env;
    const termRows = (await db.query(
      `select slug, label from app.terms where vocabulary_id=$1 and env=$2 order by slug`,
      [vidRow.id, termEnv])).rows;
    const terms = termRows.map((r: any) => ({ slug: r.slug, label: r.label ?? r.slug }));

    bindings.push({
      field: vocabSlug,
      label: vocab.label,
      multiple: vocab.multiple ?? false,
      slugs: terms.map((t) => t.slug),
      terms,
    });
  }

  return bindings;
}

/**
 * Slugifies a string for use as a vocabulary term slug.
 * Lowercase, non-alphanumeric → '-', collapsed.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
