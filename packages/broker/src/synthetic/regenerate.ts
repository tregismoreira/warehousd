import type { Pool } from "pg";
import { kindOf } from "../config/kinds";
import type { WarehousdConfig } from "../config/schema";
import { withWorkspace } from "../db/pools";
import { generateSynthetic, type SyntheticProgress } from "./generate";

// Truncate-then-generate, extracted so the CLI (`warehousd seed`), the bootstrap script and
// the admin UI share one implementation instead of three copies that can drift.
//
// data_synth only, always. Invariant 5: the generator has no read path into data_live, and
// this function has no write path into it either — the schema name is a literal.
//
// `truncate` used to stand where the `delete` below does — a **cross-tenant destructive
// statement**: it wipes every workspace's rows, not just the caller's. `db` here is the admin
// connection (superuser), which bypasses RLS outright, so `withWorkspace` cannot be the thing
// that confines this delete the way it confines a write-role connection — the `where
// workspace_id = $1` is what does that work, and it is required rather than decorative.
// `withWorkspace` is still used to set the GUC, for parity with every other data-plane
// statement and in case this ever runs on a non-superuser connection.
export async function regenerateSynthetic(
  db: Pool,
  cfg: WarehousdConfig,
  workspaceId: string,
  seed = 42,
  opts: { onProgress?: ((p: SyntheticProgress) => void) | undefined } = {},
): Promise<{ collections: string[] }> {
  const regenerated: string[] = [];
  for (const name of Object.keys(cfg.collections)) {
    const c = cfg.collections[name];
    // File collections are populated by indexCollection, not the generator; writable
    // collections hold real writes/proposals that a synthetic regen must not truncate.
    if (!c || !kindOf(c).synthesisable || c.writable) continue;
    await withWorkspace(db, workspaceId, (client) =>
      client.query(`delete from data_synth.${name} where workspace_id = $1`, [workspaceId]),
    );
    // The collection's ACL rows go with its documents. `_acl` is keyed on (workspace_id,
    // collection, document_id) — scoping the delete to this workspace leaves every other
    // workspace's ACL rows untouched, matching the data delete above.
    if (c.acl)
      await withWorkspace(db, workspaceId, (client) =>
        client.query(`delete from data_synth."_acl" where collection = $1 and workspace_id = $2`, [
          name,
          workspaceId,
        ]),
      );
    regenerated.push(name);
  }
  await generateSynthetic(db, cfg, seed, workspaceId, opts);
  return { collections: regenerated };
}
