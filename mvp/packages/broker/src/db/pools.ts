import { Pool } from "pg";
import type { BrokerContext } from "../types";

export type Pools = {
  app: Pool;   // owns app schema; NO data schema privileges
  dev: Pool;   // warehousd_dev — data_synth only
  live: Pool;  // warehousd_live — data_live only
  imp: Pool | null;  // warehousd_import — INSERT-only on data_live base tables
  end: () => Promise<void>;
};

export function createPools(urls: { app: string; dev: string; live: string; imp?: string }): Pools {
  const app = new Pool({ connectionString: urls.app });
  const dev = new Pool({ connectionString: urls.dev });
  const live = new Pool({ connectionString: urls.live });
  // Optional: a deployment with no import path configured simply has no write path into
  // data_live, which is the safer default. The import route reports it as unconfigured.
  const imp = urls.imp ? new Pool({ connectionString: urls.imp }) : null;
  return {
    app, dev, live, imp,
    end: async () => {
      await Promise.all([app.end(), dev.end(), live.end(), imp?.end()].filter(Boolean));
    },
  };
}

// The ONLY place env maps to a data pool. A dev ctx can never reach the live pool.
export function dataPool(pools: Pools, ctx: BrokerContext): Pool {
  return ctx.env === "live" ? pools.live : pools.dev;
}
