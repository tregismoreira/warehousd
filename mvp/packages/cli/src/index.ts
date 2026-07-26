#!/usr/bin/env node
import { Command } from "commander";
import { Pool } from "pg";
import { resolve } from "node:path";
import {
  loadConfig, applyConfig, generateSynthetic, createAppSchema, indexCollection,
} from "@warehousd/broker";
import { runInit } from "./init";
import { runStart } from "./start";
import { formatOutputs } from "./outputs";
import { ensureState } from "./state";

export async function runApply(projectDir: string, dbUrl: string): Promise<void> {
  const cfg = loadConfig(projectDir);
  const db = new Pool({ connectionString: dbUrl });
  try { await createAppSchema(db); await applyConfig(db, cfg); } finally { await db.end(); }
}

export async function runSeed(projectDir: string, dbUrl: string, seed = 42): Promise<void> {
  const cfg = loadConfig(projectDir);
  const db = new Pool({ connectionString: dbUrl });
  try {
    for (const name of Object.keys(cfg.collections)) {
      const c = cfg.collections[name];
      // Skip file collections — they are populated via indexCollection, not synthetic generation
      if (c.type === "file") continue;
      await db.query(`truncate data_synth.${name} cascade`);
    }
    await generateSynthetic(db, cfg, seed);
  } finally { await db.end(); }
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
  const taxonomy = c.taxonomy
    ? { field: c.taxonomy, slugs: Object.keys(cfg.taxonomies[c.taxonomy]?.terms ?? {}) }
    : undefined;
  const db = new Pool({ connectionString: dbUrl });
  try {
    return await indexCollection(db, env, collection, resolve(projectDir, dir), { taxonomy });
  } finally { await db.end(); }
}

const program = new Command();
program.name("warehousd").description("warehousd Phase 0 CLI");
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
  .requiredOption("--db <url>", "database url ($DATABASE_URL)", process.env.DATABASE_URL)
  .action(async (o) => { await runApply(o.dir, o.db); console.log("applied"); });
program.command("seed")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .requiredOption("--db <url>", "database url", process.env.DATABASE_URL)
  .option("-s, --seed <n>", "seed", "42")
  .action(async (o) => { await runSeed(o.dir, o.db, Number(o.seed)); console.log("seeded"); });
program.command("index <collection>")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .requiredOption("--db <url>", "database url", process.env.DATABASE_URL)
  .option("--env <env>", "dev|live", "dev")
  .option("--source <dir>", "override source directory")
  .action(async (collection, o) => {
    const r = await runIndex(o.dir, o.db, collection, { env: o.env, source: o.source });
    console.log(`indexed=${r.indexed} skipped=${r.skipped} deleted=${r.deleted}`);
  });

// Only parse argv when run as a binary, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) program.parseAsync();
