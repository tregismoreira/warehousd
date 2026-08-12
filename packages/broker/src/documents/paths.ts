import type { WarehousdConfig } from "../config/schema";
import { kindOf } from "../config/kinds";
import { findCollection } from "../config/load";
import { dataPool, type Pools, withWorkspace } from "../db/pools";
import type { Scope } from "./inventory";

// The approver's path picker needs the set of indexed files for a collection. It reads
// through the env-scoped pool like every other data read — a route must never query a data
// schema directly (invariant 1).
//
// `path` is usually posture:deny (it gates documents without being readable). That is fine
// here: this is grant-authoring metadata shown to an approver, not query output returned to
// a grantee, and the values never enter a BrokerResult.
//
// The workspace comes from the caller, like every other data read. It used to be pinned to
// DEFAULT_WORKSPACE_ID while the one caller passed nothing, so in a multi-tenant deployment an
// approver authoring a grant was shown the *default* tenant's file paths — a list of filenames
// belonging to somebody else, offered as the thing to scope their own grant to.
export async function listDocumentPaths(
  pools: Pools,
  scope: Scope,
  cfg: WarehousdConfig,
  collection: string,
): Promise<string[]> {
  const c = findCollection(cfg, collection);
  if (!c) throw new Error(`Unknown collection: ${collection}`);
  if (!kindOf(c).chunked) throw new Error(`Collection ${collection} is not a file collection`);
  const schema = scope.env === "dev" ? "data_synth" : "data_live";
  // `collection` is validated against the loaded config above, so this identifier
  // interpolation is safe — SQL identifiers cannot be parameterized.
  const r = await withWorkspace(dataPool(pools, scope), scope.workspaceId, (c) =>
    c.query(`select path from ${schema}.v_${collection} group by path order by path`),
  );
  return r.rows.map((x) => x.path as string);
}
