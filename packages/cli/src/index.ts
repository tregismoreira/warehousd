import { Command } from "commander";
import { Pool } from "pg";
import { resolve } from "node:path";
import {
  loadConfig, applyConfig, regenerateSynthetic, createAppSchema, indexCollection, syncDatasetTerms,
  loadTaxonomyBindings,
} from "@warehousd/broker";
import { runInit } from "./init";
import { runStart } from "./start";
import { runStop } from "./stop";
import { runStatus } from "./status";
import { formatOutputs } from "./outputs";
import { ensureState, readOutputs } from "./state";
import { resolveProject } from "./project";

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
  try { await createAppSchema(db); await applyConfig(db, cfg); } finally { await db.end(); }
}

export async function runSeed(projectDir: string, dbUrl: string, seed = 42): Promise<void> {
  const cfg = loadConfig(projectDir);
  const db = new Pool({ connectionString: dbUrl });
  try { await regenerateSynthetic(db, cfg, seed); } finally { await db.end(); }
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
  if (!dir) throw new Error(`Indexing env=live requires \`source_live\` in warehousd.yml or --source`);
  const db = new Pool({ connectionString: dbUrl });
  try {
    // Sync dataset-sourced vocabulary terms before indexing
    await syncDatasetTerms(db, cfg, env);
    const taxonomies = await loadTaxonomyBindings(db, cfg, collection, env);
    return await indexCollection(db, env, collection, resolve(projectDir, dir), { taxonomies });
  } finally { await db.end(); }
}

// WAREHOUSD_CLI_VERSION is defined by tsup at build time; fallback for source runs.
declare const WAREHOUSD_CLI_VERSION: string | undefined;

const program = new Command();
program.name("warehousd").description("warehousd CLI")
  .version(typeof WAREHOUSD_CLI_VERSION !== "undefined" ? WAREHOUSD_CLI_VERSION : "0.0.0-dev");
program.command("init")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--force", "overwrite an existing warehousd.yml")
  .action(async (o) => {
    const r = await runInit(o.dir, { force: o.force });
    for (const f of r.created) console.log(`created ${f}`);
    for (const f of r.skipped) console.log(`skipped ${f} (already exists)`);
    console.log("\nNext: warehousd start");
  });
program.command("start")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("-s, --seed <n>", "synthetic seed", "42")
  .option("--verbose", "log every docker command")
  .action(async (o) => {
    const outputs = await runStart(o.dir, { seed: Number(o.seed), verbose: o.verbose });
    const st = ensureState(o.dir);
    console.log(formatOutputs(outputs, {
      adminEmail: "admin@warehousd.local",
      adminPassword: st.adminPassword,
    }));
  });
program.command("apply")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .action(async (o) => {
    const db = resolveDbUrl(o.dir, o.db);
    await runApply(o.dir, db);
    console.log("applied");
  });
program.command("seed")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .option("-s, --seed <n>", "seed", "42")
  .action(async (o) => {
    const db = resolveDbUrl(o.dir, o.db);
    await runSeed(o.dir, db, Number(o.seed));
    console.log("seeded");
  });
program.command("index <collection>")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .option("--env <env>", "dev|live", "dev")
  .option("--source <dir>", "override source directory")
  .action(async (collection, o) => {
    const db = resolveDbUrl(o.dir, o.db);
    const r = await runIndex(o.dir, db, collection, { env: o.env, source: o.source });
    console.log(`indexed=${r.indexed} skipped=${r.skipped} deleted=${r.deleted}`);
  });
program.command("stop")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--destroy", "remove volume and data (irreversible)")
  .option("--yes", "skip confirmation for --destroy")
  .action(async (o) => {
    await runStop(o.dir, { destroy: o.destroy, yes: o.yes });
    console.log("stopped");
  });
program.command("status")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .action(async (o) => {
    const result = await runStatus(o.dir);
    process.exit(result.healthy ? 0 : 1);
  });
program.command("regen-synth")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .option("--db <url>", "database url")
  .option("-s, --seed <n>", "seed", "42")
  .action(async (o) => {
    const db = resolveDbUrl(o.dir, o.db);
    const cfg = loadConfig(o.dir);
    const pool = new Pool({ connectionString: db });
    try {
      // Seed truncates and generates synthetic data
      await runSeed(o.dir, db, Number(o.seed));
      // Sync dataset-sourced vocabulary terms
      await syncDatasetTerms(pool, cfg, "dev");
      // Re-index all file collections
      for (const [name, c] of Object.entries(cfg.collections)) {
        if (c.type === "file") {
          const env = "dev";
          const dir = c.source!;
          const taxonomies = await loadTaxonomyBindings(pool, cfg, name, env);
          await indexCollection(pool, env, name, resolve(o.dir, dir), { taxonomies });
        }
      }
    } finally {
      await pool.end();
    }
    console.log("regenerated synthetic data");
  });

// Only parse argv when run as a binary, not when imported by tests.
const isMainModule =
  (typeof require !== 'undefined' && require.main === module) ||
  (typeof import.meta !== 'undefined' && import.meta.url === `file://${process.argv[1]}`);
if (isMainModule) program.parseAsync();
