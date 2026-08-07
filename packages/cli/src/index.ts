// The CLI's library surface: the functions that do work against a database, imported directly by
// the unit suites. The commander wiring that calls them lives in program.ts, which is also the
// build entry point — see the note at the top of that file for why the two are separate.

import { Pool } from "pg";
import { makeBinaryExtractor, makeEmbedder } from "@warehousd/providers";
import { resolve } from "node:path";
import {
  loadConfig,
  applyConfig,
  regenerateSynthetic,
  migrateApp,
  runProjectMigrations,
  planFromSchema,
  indexCollection,
  embedCollection,
  syncDatasetTerms,
  loadTaxonomyBindings,
  fileMetadataFields,
  type ApplyProgress,
  type EmbedProgress,
  type IndexProgress,
  type SyntheticProgress,
} from "@warehousd/broker";
import { readOutputs } from "./state";
import { silentReporter, type Reporter } from "./ui/reporter";
import { trackStepWith } from "./ui/progress";

export function resolveDbUrl(dir: string, explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const o = readOutputs(dir);
  if (o) return o.databaseUrl;
  throw new Error("No database. Pass --db, set DATABASE_URL, or run `warehousd start` first.");
}

/**
 * The same lookup, for callers where "no database" is an answer rather than a failure.
 *
 * `warehousd migrate plan` is the case: before a stack is running, and against a Fly deployment
 * whose Postgres credentials the CLI never holds, the last deployed config snapshot is the only
 * previous state there is — and a plan built from it is still worth printing.
 */
export function tryResolveDbUrl(dir: string, explicit?: string): string | undefined {
  try {
    return resolveDbUrl(dir, explicit);
  } catch {
    return undefined;
  }
}

/**
 * Apply the config, running the project's pending migrations first.
 *
 * The order is the contract, and it is the same one the container entrypoint uses. Migrations run
 * before applyConfig so that a reviewed ALTER has already happened by the time applyConfig
 * re-derives the plan from the live schema — which is also why the ledger records no intent. The
 * check is the schema, so a migration that claims to fix a type but does not still blocks.
 *
 * `migrated` is the versions this call applied; `rebuilt` names the data_synth tables it dropped
 * and recreated, so the caller can say that `warehousd seed` will repopulate them.
 */
export async function runApply(
  projectDir: string,
  dbUrl: string,
  opts: { reporter?: Reporter } = {},
): Promise<{ migrated: string[]; rebuilt: string[] }> {
  const reporter = opts.reporter ?? silentReporter;
  const cfg = loadConfig(projectDir);
  const db = new Pool({ connectionString: dbUrl });
  try {
    await migrateApp(db);
    const migrated = await runProjectMigrations(db, projectDir);
    const rebuilt = [
      ...new Set(
        (await planFromSchema(db, cfg))
          .filter((c) => c.destructive && c.env === "dev")
          .map((c) => c.table),
      ),
    ];
    // A schema change against twenty collections used to render one unchanging spinner, and
    // "still working" is indistinguishable from "hung" without the collection name.
    const t = trackStepWith<ApplyProgress>(reporter, "applying", "warehousd.yml", (p) => ({
      done: p.done,
      total: p.total,
      label: p.label,
    }));
    try {
      await applyConfig(db, cfg, { onProgress: t.onProgress });
      t.step.done(`${Object.keys(cfg.collections).length} collections`);
    } catch (e) {
      t.step.fail();
      throw e;
    }
    return { migrated, rebuilt };
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
  opts: { reindex?: boolean; reporter?: Reporter } = {},
): Promise<{ seed: number; reindexed: string[] }> {
  const reporter = opts.reporter ?? silentReporter;
  const cfg = loadConfig(projectDir);
  const db = new Pool({ connectionString: dbUrl });
  // Dataset-backed vocabularies read their terms out of the rows just generated, so the sync
  // has to happen here — a later `warehousd index` would otherwise see a stale term set.
  try {
    const gen = trackStepWith<SyntheticProgress>(reporter, "seeding", "synthetic data", (p) => ({
      done: p.done,
      total: p.total,
      label: p.label,
    }));
    try {
      await regenerateSynthetic(db, cfg, seed, { onProgress: gen.onProgress });
      gen.step.done();
    } catch (e) {
      gen.step.fail();
      throw e;
    }
    await syncDatasetTerms(db, cfg, "dev");
    if (opts.reindex === false) return { seed, reindexed: [] };
    const reindexed: string[] = [];
    for (const [name, c] of Object.entries(cfg.collections)) {
      if (c.type !== "file") continue;
      // `metadata` is not optional in practice: every other index call site passes it, and
      // omitting it here would re-index a changed file with its declared metadata columns left
      // null — the exact drift fileMetadataFields exists to prevent.
      const taxonomies = await loadTaxonomyBindings(db, cfg, name, "dev");
      const t = indexTracker(reporter, name);
      try {
        const r = await indexCollection(db, "dev", name, resolve(projectDir, c.source!), {
          taxonomies,
          metadata: fileMetadataFields(c),
          onProgress: t.onProgress,
        });
        t.step.done(`${r.indexed} indexed, ${r.skipped} unchanged`);
      } catch (e) {
        t.step.fail();
        throw e;
      }
      reindexed.push(name);
    }
    return { seed, reindexed };
  } finally {
    await db.end();
  }
}

// Indexing has two passes that measure different things — walking the source directory, then
// pruning rows whose file has gone. Shown with the phase in the label rather than as two totals,
// which would look like a bar resetting from 200/200 to 3.
function indexTracker(reporter: Reporter, collection: string) {
  return trackStepWith<IndexProgress>(reporter, "indexing", collection, (p) => ({
    done: p.done,
    total: p.total,
    label: p.phase === "prune" ? "pruning" : undefined,
  }));
}

export async function runIndex(
  projectDir: string,
  dbUrl: string,
  collection: string,
  opts: {
    env?: "dev" | "live";
    source?: string;
    embed?: boolean;
    reporter?: Reporter;
  } = {},
): Promise<{ indexed: number; skipped: number; deleted: number }> {
  const reporter = opts.reporter ?? silentReporter;
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
    // PDF/DOCX support and embedding are both injected rather than reached for by the broker:
    // the parsers and the model live in @warehousd/providers. Passing the extractor is what
    // makes the walk pick up binaries at all.
    const extractor = makeBinaryExtractor();
    const embedder =
      cfg.embedding && opts.embed !== false ? makeEmbedder(cfg.embedding) : undefined;
    const t = indexTracker(reporter, collection);
    try {
      const r = await indexCollection(db, env, collection, resolve(projectDir, dir), {
        extractor,
        ...(embedder ? { embedder } : {}),
        taxonomies,
        metadata,
        onProgress: t.onProgress,
      });
      t.step.done(`${r.indexed} indexed, ${r.skipped} unchanged, ${r.deleted} pruned`);
      return r;
    } catch (e) {
      t.step.fail();
      throw e;
    }
  } finally {
    await db.end();
  }
}

/**
 * Fill the embedding column for every file collection, or one of them.
 *
 * Separate from `index` because they fail for different reasons and recover differently: indexing
 * is local and fast, embedding may call a provider and is the part worth resuming. embedCollection
 * only ever touches chunks with a null embedding, so re-running this after an interruption costs
 * nothing already done.
 */
export async function runEmbed(
  projectDir: string,
  dbUrl: string,
  opts: { collection?: string; env?: "dev" | "live"; reporter?: Reporter } = {},
): Promise<{ embedded: number; collections: string[] }> {
  const reporter = opts.reporter ?? silentReporter;
  const cfg = loadConfig(projectDir);
  if (!cfg.embedding)
    throw new Error(
      "No `embedding:` block in warehousd.yml — semantic search is not configured for this project",
    );
  const env = opts.env ?? "dev";
  const names = opts.collection
    ? [opts.collection]
    : Object.entries(cfg.collections)
        .filter(([, c]) => c.type === "file")
        .map(([n]) => n);
  for (const n of names) {
    const c = cfg.collections[n];
    if (!c) throw new Error(`Unknown collection: ${n}`);
    if (c.type !== "file") throw new Error(`Collection ${n} is not a file collection`);
  }
  const embedder = makeEmbedder(cfg.embedding);
  const db = new Pool({ connectionString: dbUrl });
  try {
    let embedded = 0;
    for (const n of names) {
      // `EmbedProgress` predates the `{ done, total }` convention and is `{ embedded, remaining }`,
      // so the total is derived rather than reported — it is only knowable while there is work
      // left, which is exactly when a total is worth showing.
      const t = trackStepWith<EmbedProgress>(reporter, "embedding", n, (p) => ({
        done: p.embedded,
        total: p.embedded + p.remaining,
      }));
      try {
        const r = await embedCollection(db, env, n, embedder, { onProgress: t.onProgress });
        embedded += r.embedded;
        t.step.done(`${r.embedded} chunks`);
      } catch (e) {
        t.step.fail();
        throw e;
      }
    }
    return { embedded, collections: names };
  } finally {
    await db.end();
  }
}
