#!/usr/bin/env node
import { Command } from "commander";
import { Pool } from "pg";
import {
  loadConfig, applyConfig, generateSynthetic, createAppSchema,
} from "@warehousd/broker";

export async function runApply(projectDir: string, dbUrl: string): Promise<void> {
  const cfg = loadConfig(projectDir);
  const db = new Pool({ connectionString: dbUrl });
  try { await createAppSchema(db); await applyConfig(db, cfg); } finally { await db.end(); }
}

export async function runSeed(projectDir: string, dbUrl: string, seed = 42): Promise<void> {
  const cfg = loadConfig(projectDir);
  const db = new Pool({ connectionString: dbUrl });
  try {
    for (const name of Object.keys(cfg.collections))
      await db.query(`truncate data_synth.${name} cascade`);
    await generateSynthetic(db, cfg, seed);
  } finally { await db.end(); }
}

const program = new Command();
program.name("warehousd").description("warehousd Phase 0 CLI");
program.command("apply")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .requiredOption("--db <url>", "database url ($DATABASE_URL)", process.env.DATABASE_URL)
  .action(async (o) => { await runApply(o.dir, o.db); console.log("applied"); });
program.command("seed")
  .option("-d, --dir <dir>", "project dir", process.cwd())
  .requiredOption("--db <url>", "database url", process.env.DATABASE_URL)
  .option("-s, --seed <n>", "seed", "42")
  .action(async (o) => { await runSeed(o.dir, o.db, Number(o.seed)); console.log("seeded"); });

// Only parse argv when run as a binary, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) program.parseAsync();
