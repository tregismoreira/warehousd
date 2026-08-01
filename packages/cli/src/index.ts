// The CLI's library surface: the functions that do work against a database, imported directly by
// the unit suites. The commander wiring that calls them lives in program.ts, which is also the
// build entry point — see the note at the top of that file for why the two are separate.

import { Pool } from "pg";
import { resolve } from "node:path";
import {
  loadConfig,
  applyConfig,
  regenerateSynthetic,
  migrateApp,
  indexCollection,
  syncDatasetTerms,
  loadTaxonomyBindings,
  fileMetadataFields,
} from "@warehousd/broker";
import { readOutputs } from "./state";

export function resolveDbUrl(dir: string, explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const o = readOutputs(dir);
  if (o) return o.databaseUrl;
  throw new Error("No database. Pass --db, set DATABASE_URL, or run `warehousd start` first.");
}

export async function runApply(projectDir: string, dbUrl: string): Promise<void> {
  const cfg = loadConfig(projectDir);
  const db = new Pool({ connectionString: dbUrl });
  try {
    await migrateApp(db);
    await applyConfig(db, cfg);
  } finally {
    await db.end();
  }
}

/**
 * Regenerate the dev synthetic data, then re-index the file collections that depend on it.
 *
 * The re-index is the default because it is a repair, not an extra: `regenerateSynthetic`
 * truncates the dataset collections `cascade` and `syncDatasetTerms` rebuilds the dev term set
 * from the rows just generated, which leaves every file row's taxonomy links pointing at the
 * term set that was replaced. `reindex: false` is for iterating on a dataset generator in a
 * project whose file collections are not involved.
 */
export async function runSeed(
  projectDir: string,
  dbUrl: string,
  seed = 42,
  opts: { reindex?: boolean } = {},
): Promise<{ seed: number; reindexed: string[] }> {
  const cfg = loadConfig(projectDir);
  const db = new Pool({ connectionString: dbUrl });
  // Dataset-backed vocabularies read their terms out of the rows just generated, so the sync
  // has to happen here — a later `warehousd index` would otherwise see a stale term set.
  try {
    await regenerateSynthetic(db, cfg, seed);
    await syncDatasetTerms(db, cfg, "dev");
    if (opts.reindex === false) return { seed, reindexed: [] };
    const reindexed: string[] = [];
    for (const [name, c] of Object.entries(cfg.collections)) {
      if (c.type !== "file") continue;
      // `metadata` is not optional in practice: every other index call site passes it, and
      // omitting it here would re-index a changed file with its declared metadata columns left
      // null — the exact drift fileMetadataFields exists to prevent.
      const taxonomies = await loadTaxonomyBindings(db, cfg, name, "dev");
      await indexCollection(db, "dev", name, resolve(projectDir, c.source!), {
        taxonomies,
        metadata: fileMetadataFields(c),
      });
      reindexed.push(name);
    }
    return { seed, reindexed };
  } finally {
    await db.end();
  }
}

export async function runIndex(
  projectDir: string,
  dbUrl: string,
  collection: string,
  opts: { env?: "dev" | "live"; source?: string } = {},
): Promise<{ indexed: number; skipped: number; deleted: number }> {
  const cfg = loadConfig(projectDir);
  const c = cfg.collections[collection];
  if (!c) throw new Error(`Unknown collection: ${collection}`);
  if (c.type !== "file") throw new Error(`Collection ${collection} is not a file collection`);
  const env = opts.env ?? "dev";
  // Invariant 5: the YAML `source` dir is DEV content. Live indexing must be explicit.
  const dir = env === "dev" ? (opts.source ?? c.source!) : (opts.source ?? c.source_live);
  if (!dir)
    throw new Error(`Indexing env=live requires \`source_live\` in warehousd.yml or --source`);
  const db = new Pool({ connectionString: dbUrl });
  try {
    // Sync dataset-sourced vocabulary terms before indexing
    await syncDatasetTerms(db, cfg, env);
    const taxonomies = await loadTaxonomyBindings(db, cfg, collection, env);
    const metadata = fileMetadataFields(c);
    return await indexCollection(db, env, collection, resolve(projectDir, dir), {
      taxonomies,
      metadata,
    });
  } finally {
    await db.end();
  }
}
