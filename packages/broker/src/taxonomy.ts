import type { Pool } from "pg";
import type { WarehousdConfig } from "./config/schema";

/**
 * Taxonomy binding loaded from the database for a specific environment.
 */
export type TaxonomyBinding = {
  field: string;
  label: string;
  multiple: boolean;
  slugs: string[];
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

    // Slugify and upsert terms from the dataset
    const rows = (await db.query(
      `select distinct "${vocab.source.slug}" as slug, "${vocab.source.label}" as label from ${schema}."${vocab.source.collection}" where "${vocab.source.slug}" is not null`)).rows;

    for (const row of rows) {
      const slug = slugify(row.slug);
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

  for (const vocabSlug of c.taxonomies) {
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
      `select slug from app.terms where vocabulary_id=$1 and env=$2 order by slug`,
      [vidRow.id, termEnv])).rows;

    bindings.push({
      field: vocabSlug,
      label: vocab.label,
      multiple: vocab.multiple ?? false,
      slugs: termRows.map((r: any) => r.slug),
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
