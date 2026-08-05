import type { Pool } from "pg";

/**
 * Anything that runs a statement — a `Pool` or one `PoolClient` checked out of it.
 *
 * It exists for the functions that must be able to run on ONE connection. `applyConfig` sets a
 * session `search_path` and then emits DDL that depends on it (see db/search-path.ts), which is
 * only sound if every statement in between lands on the same connection. A `Pool` cannot promise
 * that: `pool.query` picks an idle client, and "the sequential case happens to reuse one" is an
 * implementation detail, not a contract.
 *
 * `Pick<Pool, "query">` rather than `Pool | PoolClient`: a union of two overloaded methods is not
 * callable in TypeScript, and the query signature is the whole of what these functions use.
 */
export type Queryable = Pick<Pool, "query">;
