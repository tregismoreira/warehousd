import { Pool, type PoolClient } from "pg";
import type { BrokerContext } from "../types";

export type Pools = {
  app: Pool;   // owns app schema; NO data schema privileges
  dev: Pool;   // warehousd_dev — data_synth only
  live: Pool;  // warehousd_live — data_live only
  imp: Pool | null;  // warehousd_import — INSERT-only on data_live base tables
  devWrite: Pool | null;  // warehousd_dev_write — write to data_synth base tables
  liveWrite: Pool | null;  // warehousd_live_write — write to data_live base tables
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

export function createPools(urls: { app: string; dev: string; live: string; imp?: string; devWrite?: string; liveWrite?: string }): Pools {
  const app = new Pool({ connectionString: urls.app });
  const dev = new Pool({ connectionString: urls.dev });
  const live = new Pool({ connectionString: urls.live });
  // Optional: a deployment with no import path configured simply has no write path into
  // data_live, which is the safer default. The import route reports it as unconfigured.
  const imp = urls.imp ? new Pool({ connectionString: urls.imp }) : null;
  const devWrite = urls.devWrite ? new Pool({ connectionString: urls.devWrite }) : null;
  const liveWrite = urls.liveWrite ? new Pool({ connectionString: urls.liveWrite }) : null;
  app.on("error", onPoolError("app"));
  dev.on("error", onPoolError("dev"));
  live.on("error", onPoolError("live"));
  imp?.on("error", onPoolError("import"));
  devWrite?.on("error", onPoolError("devWrite"));
  liveWrite?.on("error", onPoolError("liveWrite"));
  return {
    app, dev, live, imp, devWrite, liveWrite,
    end: async () => {
      await Promise.all([app.end(), dev.end(), live.end(), imp?.end(), devWrite?.end(), liveWrite?.end()].filter(Boolean));
    },
  };
}

// The ONLY place env maps to a data pool. A dev ctx can never reach the live pool.
export function dataPool(pools: Pools, ctx: BrokerContext): Pool {
  return ctx.env === "live" ? pools.live : pools.dev;
}

// The ONLY place env maps to a write pool. Returns null if the deployment has no write path
// configured for this env (safer default: opt-in to mutations).
export function writePool(pools: Pools, ctx: BrokerContext): Pool | null {
  return ctx.env === "live" ? pools.liveWrite : pools.devWrite;
}

// Every data-plane statement runs inside a transaction whose warehousd.org_id is set
// from ctx.orgId. `set_config(..., true)` is transaction-local, so a pooled connection
// can never leak one org's setting into another's query.
export async function withOrg<T>(
  pool: Pool, orgId: string, fn: (c: PoolClient) => Promise<T>,
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
