import {
  createPools,
  makeBroker,
  loadConfig,
  type Pools,
  type WarehousdConfig,
} from "@warehousd/broker";
import { statSync, existsSync } from "node:fs";
import { join } from "node:path";

// One set of pools per server process. URLs come from env (see docker-compose.yml).
// Config is cached per-process but reloaded when warehousd.yml or warehousd.local.yml
// changes (detected via mtime). This ensures the broker's enforcement and route
// validation never read different YAML generations after `warehousd apply`.
interface CachedState {
  pools: Pools;
  broker: ReturnType<typeof makeBroker>;
  cfg: WarehousdConfig;
  baselineMtime: number;
  localMtime: number | null;
}

let cached: CachedState | null = null;

function getProjectDir(): string {
  return process.env.WAREHOUSD_PROJECT_DIR ?? process.cwd();
}

function getFileMtimes(dir: string): { base: number; local: number | null } {
  const basePath = join(dir, "warehousd.yml");
  const localPath = join(dir, "warehousd.local.yml");
  return {
    base: statSync(basePath).mtimeMs,
    local: existsSync(localPath) ? statSync(localPath).mtimeMs : null,
  };
}

function needsRebuild(dir: string, state: CachedState): boolean {
  const mtimes = getFileMtimes(dir);
  return mtimes.base !== state.baselineMtime || mtimes.local !== state.localMtime;
}

function ensureConfigAndBroker(dir: string): CachedState {
  if (cached && !needsRebuild(dir, cached)) return cached;

  const cfg = loadConfig(dir);
  const mtimes = getFileMtimes(dir);

  if (!cached) {
    // First call: create pools (expensive, reused forever)
    // The write URLs are optional: a deployment that sets neither has no mutation path at
    // all, which is the safer default. broker.mutate reports that as not_writable rather
    // than failing at connect time.
    const pools = createPools({
      app: process.env.APP_DATABASE_URL!,
      dev: process.env.DEV_DATABASE_URL!,
      live: process.env.LIVE_DATABASE_URL!,
      imp: process.env.IMPORT_DATABASE_URL,
      devWrite: process.env.DEV_WRITE_DATABASE_URL,
      liveWrite: process.env.LIVE_WRITE_DATABASE_URL,
    });
    cached = {
      pools,
      broker: makeBroker(pools, cfg),
      cfg,
      baselineMtime: mtimes.base,
      localMtime: mtimes.local,
    };
  } else {
    // Config changed: rebuild broker with same pools
    cached.broker = makeBroker(cached.pools, cfg);
    cached.cfg = cfg;
    cached.baselineMtime = mtimes.base;
    cached.localMtime = mtimes.local;
  }

  return cached;
}

// Single source of config for the whole process. The broker's enforcement and the
// routes' validation must never read different generations of warehousd.yml — an
// admin flipping a posture to `deny` has to bind both at once. mtime-keyed so
// `warehousd apply` is picked up without a restart.
export function getConfig(): WarehousdConfig {
  const dir = getProjectDir();
  return ensureConfigAndBroker(dir).cfg;
}

export function getBroker() {
  const dir = getProjectDir();
  return ensureConfigAndBroker(dir);
}

export function getAppPool() {
  return getBroker().pools.app;
}
