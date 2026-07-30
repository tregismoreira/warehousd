import type { WarehousdConfig } from "../config/schema";
import { DEFAULT_ORG_ID } from "../db/migrate-app";
import { findCollection } from "../config/load";
import { dataPool, type Pools, withOrg } from "../db/pools";

// The approver's path picker needs the set of indexed files for a collection. It reads
// through the env-scoped pool like every other data read — a route must never query a data
// schema directly (invariant 1).
//
// `path` is usually posture:deny (it gates documents without being readable). That is fine
// here: this is grant-authoring metadata shown to an approver, not query output returned to
// a grantee, and the values never enter a BrokerResult.
export async function listDocumentPaths(
  pools: Pools,
  env: "dev" | "live",
  cfg: WarehousdConfig,
  collection: string,
): Promise<string[]> {
  const c = findCollection(cfg, collection);
  if (!c) throw new Error(`Unknown collection: ${collection}`);
  if (c.type !== "file") throw new Error(`Collection ${collection} is not a file collection`);
  const schema = env === "dev" ? "data_synth" : "data_live";
  // `collection` is validated against the loaded config above, so this identifier
  // interpolation is safe — SQL identifiers cannot be parameterized.
  const r = await withOrg(dataPool(pools, { env }), DEFAULT_ORG_ID, (c) =>
    c.query(`select path from ${schema}.v_${collection} group by path order by path`),
  );
  return r.rows.map((x) => x.path as string);
}
