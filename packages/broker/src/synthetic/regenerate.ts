import type { Pool } from "pg";
import { kindOf } from "../config/kinds";
import type { WarehousdConfig } from "../config/schema";
import { generateSynthetic, type SyntheticProgress } from "./generate";

// Truncate-then-generate, extracted so the CLI (`warehousd seed`), the bootstrap script and
// the admin UI share one implementation instead of three copies that can drift.
//
// data_synth only, always. Invariant 5: the generator has no read path into data_live, and
// this function has no write path into it either — the schema name is a literal.
export async function regenerateSynthetic(
  db: Pool,
  cfg: WarehousdConfig,
  seed = 42,
  opts: { onProgress?: ((p: SyntheticProgress) => void) | undefined } = {},
): Promise<{ collections: string[] }> {
  const regenerated: string[] = [];
  for (const name of Object.keys(cfg.collections)) {
    const c = cfg.collections[name];
    // File collections are populated by indexCollection, not the generator; writable
    // collections hold real writes/proposals that a synthetic regen must not truncate.
    if (!c || !kindOf(c).synthesisable || c.writable) continue;
    await db.query(`truncate data_synth.${name} cascade`);
    // The collection's ACL rows go with its documents. `_acl` is a separate table keyed on
    // document id, so a truncate leaves rows behind pointing at documents that no longer exist —
    // and the generator hands out fresh ids, so a stale row would either sit there forever or,
    // on a collection whose pk is not a uuid, silently restrict a newly generated document that
    // happened to take the same key.
    if (c.acl) await db.query(`delete from data_synth."_acl" where collection = $1`, [name]);
    regenerated.push(name);
  }
  await generateSynthetic(db, cfg, seed, opts);
  return { collections: regenerated };
}
