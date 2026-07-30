import type { Pool } from "pg";
import type { WarehousdConfig } from "../config/schema";
import { generateSynthetic } from "./generate";

// Truncate-then-generate, extracted so the CLI (`warehousd seed`), the bootstrap script and
// the admin UI share one implementation instead of three copies that can drift.
//
// data_synth only, always. Invariant 5: the generator has no read path into data_live, and
// this function has no write path into it either — the schema name is a literal.
export async function regenerateSynthetic(
  db: Pool,
  cfg: WarehousdConfig,
  seed = 42,
): Promise<{ collections: string[] }> {
  const regenerated: string[] = [];
  for (const name of Object.keys(cfg.collections)) {
    const c = cfg.collections[name];
    // File collections are populated by indexCollection, not the generator; writable
    // collections hold real writes/proposals that a synthetic regen must not truncate.
    if (!c || c.type === "file" || c.writable) continue;
    await db.query(`truncate data_synth.${name} cascade`);
    regenerated.push(name);
  }
  await generateSynthetic(db, cfg, seed);
  return { collections: regenerated };
}
