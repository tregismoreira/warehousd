import { Pool, type PoolClient } from "pg";
import type { BrokerContext } from "../types";

export type Pools = {
  app: Pool; // owns app schema; NO data schema privileges
  dev: Pool; // warehousd_dev — data_synth only
  live: Pool; // warehousd_live — data_live only
  imp: Pool | null; // warehousd_import — INSERT-only on data_live base tables
  devWrite: Pool | null; // warehousd_dev_write — write to data_synth base tables
  liveWrite: Pool | null; // warehousd_live_write — write to data_live base tables
  end: () => Promise<void>;
};

// pg reports failures on *idle* clients via the pool's "error" event. With no listener
// Node treats it as an unhandled error and takes the process down, so a Postgres restart,
// a failover, or an admin disconnect would kill the server instead of letting the pool
// reconnect. 57P01 is the server saying it closed the connection on purpose (shutdown, or
// `drop database ... with (force)` against a disposable test DB) — expected, not actionable.
export function onPoolError(name: string) {
  return (err: Error & { code?: string }) => {
    if (err.code === "57P01") return;
    console.error(`[pool:${name}] idle client error:`, err.message);
  };
}

// No statement was bounded before this, so one slow join or a `like '%…'` scan pinned a pool
// connection for as long as Postgres was willing to work — and a pool has a finite number of
// them, so enough of those is an outage rather than a slow query.
//
// Two budgets, not one. The request-serving pools carry a short bound: broker verbs read one
// document or one page of a view, and anything taking tens of seconds there is a pathology, not
// a workload. The app and import pools carry a long one, because real work runs on them at
// request time — `POST /api/admin/regen-synth` calls regenerateSynthetic on the app pool, which
// takes seconds per collection, and the import path streams whole files. Applying the short
// bound everywhere would have broken both; applying the long bound everywhere would leave the
// query path effectively unbounded.
//
// A bound that is wrong is still better than none: these are ceilings on pathology, not
// deadlines, so they are deliberately generous and overridable per deployment.
const num = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  // A typo must not silently disable the ceiling it was meant to raise. 0 is Postgres's spelling
  // of "no limit" and is accepted deliberately, for an operator who has decided to opt out.
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

function timeouts(kind: "query" | "bulk") {
  const statement_timeout =
    kind === "query"
      ? num("WAREHOUSD_STATEMENT_TIMEOUT_MS", 30_000)
      : num("WAREHOUSD_BULK_STATEMENT_TIMEOUT_MS", 600_000);
  return {
    statement_timeout,
    // withOrg wraps every data-plane call in a transaction. If the JavaScript between `begin` and
    // `commit` stalls, statement_timeout never fires — no statement is running — and the
    // transaction holds its locks and its xmin indefinitely, which also stops vacuum. This is the
    // bound for that case, and it is the one a statement timeout cannot cover.
    idle_in_transaction_session_timeout: statement_timeout > 0 ? statement_timeout * 2 : 0,
    // Without this a Postgres that accepts TCP but never completes startup leaves the caller
    // waiting forever, which surfaces as a hung request rather than a refusal.
    connectionTimeoutMillis: num("WAREHOUSD_CONNECT_TIMEOUT_MS", 10_000),
  };
}

// The optional URLs are spelled `?: string | undefined` rather than `?: string`: every caller
// builds this bag straight out of `process.env`, where a missing variable is `undefined` and not an
// absent key. Under `exactOptionalPropertyTypes` those are different types, and it is the former
// that is true here.
export function createPools(urls: {
  app: string;
  dev: string;
  live: string;
  imp?: string | undefined;
  devWrite?: string | undefined;
  liveWrite?: string | undefined;
}): Pools {
  const q = timeouts("query"),
    bulk = timeouts("bulk");
  const app = new Pool({ connectionString: urls.app, ...bulk });
  const dev = new Pool({ connectionString: urls.dev, ...q });
  const live = new Pool({ connectionString: urls.live, ...q });
  // Optional: a deployment with no import path configured simply has no write path into
  // data_live, which is the safer default. The import route reports it as unconfigured.
  const imp = urls.imp ? new Pool({ connectionString: urls.imp, ...bulk }) : null;
  const devWrite = urls.devWrite ? new Pool({ connectionString: urls.devWrite, ...q }) : null;
  const liveWrite = urls.liveWrite ? new Pool({ connectionString: urls.liveWrite, ...q }) : null;
  app.on("error", onPoolError("app"));
  dev.on("error", onPoolError("dev"));
  live.on("error", onPoolError("live"));
  imp?.on("error", onPoolError("import"));
  devWrite?.on("error", onPoolError("devWrite"));
  liveWrite?.on("error", onPoolError("liveWrite"));
  return {
    app,
    dev,
    live,
    imp,
    devWrite,
    liveWrite,
    end: async () => {
      // Filter the pools, then map to end() — not the other way round. `[…, imp?.end()]` builds an
      // array whose type includes `undefined`, and `.filter(Boolean)` does not narrow it, so
      // Promise.all was being handed a possibly-non-thenable list.
      await Promise.all(
        [app, dev, live, imp, devWrite, liveWrite]
          .filter((p): p is Pool => p !== null)
          .map((p) => p.end()),
      );
    },
  };
}

// The ONLY place env maps to a data pool. A dev ctx can never reach the live pool.
//
// `Pick<…, "env">` rather than the whole context: env is the only thing either of these reads, and
// asking for the whole context made a caller that has no user or org fabricate one to get a pool.
export function dataPool(pools: Pools, ctx: Pick<BrokerContext, "env">): Pool {
  return ctx.env === "live" ? pools.live : pools.dev;
}

// The ONLY place env maps to a write pool. Returns null if the deployment has no write path
// configured for this env (safer default: opt-in to mutations).
export function writePool(pools: Pools, ctx: Pick<BrokerContext, "env">): Pool | null {
  return ctx.env === "live" ? pools.liveWrite : pools.devWrite;
}

// Every data-plane statement runs inside a transaction whose warehousd.org_id is set
// from ctx.orgId. `set_config(..., true)` is transaction-local, so a pooled connection
// can never leak one org's setting into another's query.
export async function withOrg<T>(
  pool: Pool,
  orgId: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('warehousd.org_id', $1, true)", [orgId]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {}); // suppress error if already rolled back
    throw err;
  } finally {
    client.release();
  }
}
