import { createPools, makeBroker, loadConfig, type Pools } from "@warehousd/broker";

// One set of pools per server process. URLs come from env (see docker-compose.yml).
let cached: { broker: ReturnType<typeof makeBroker>; pools: Pools } | null = null;

export function getBroker() {
  if (cached) return cached;
  const cfg = loadConfig(process.env.WAREHOUSD_PROJECT_DIR ?? process.cwd());
  const pools = createPools({
    app:  process.env.APP_DATABASE_URL!,
    dev:  process.env.DEV_DATABASE_URL!,
    live: process.env.LIVE_DATABASE_URL!,
  });
  cached = { broker: makeBroker(pools, cfg), pools };
  return cached;
}
export function getAppPool() { return getBroker().pools.app; }
