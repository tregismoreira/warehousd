import { Pool } from "pg";
import type { BrokerContext } from "../types";

export type Pools = {
  app: Pool;   // owns app schema; NO data schema privileges
  dev: Pool;   // warehousd_dev — data_synth only
  live: Pool;  // warehousd_live — data_live only
  end: () => Promise<void>;
};

export function createPools(urls: { app: string; dev: string; live: string }): Pools {
  const app = new Pool({ connectionString: urls.app });
  const dev = new Pool({ connectionString: urls.dev });
  const live = new Pool({ connectionString: urls.live });
  return { app, dev, live, end: async () => { await Promise.all([app.end(), dev.end(), live.end()]); } };
}

// The ONLY place env maps to a data pool. A dev ctx can never reach the live pool.
export function dataPool(pools: Pools, ctx: BrokerContext): Pool {
  return ctx.env === "live" ? pools.live : pools.dev;
}
