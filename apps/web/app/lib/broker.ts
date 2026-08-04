import {
  createPools,
  makeBroker,
  loadConfig,
  dataRoleUrl,
  type Pools,
  type WarehousdConfig,
  type Embedder,
} from "@warehousd/broker";
import { makeEmbedder } from "@warehousd/providers";
import { statSync, existsSync } from "node:fs";
import { join } from "node:path";

// The four role-scoped URLs are derived here rather than supplied, because the process that used
// to compute them cannot hand them over. The image entrypoint sets them on its own `process.env`
// and exits; the Dockerfile runs it as `sh -c "entrypoint && next start"`, so the server is a
// sibling process that never inherits them. Neither `warehousd start` nor docker-compose.yml
// passes them either, and `createPools` does not invent them — so every dev/live query in a
// container was reaching a pool built from libpq defaults. `/api/health` never touches those
// pools, which is why the stack still reported healthy and CI stayed green.
//
// Deriving is also the only option a Fly deployment has: Fly generates the Postgres credentials
// at `postgres attach` time and exposes them as DATABASE_URL, so no caller can know them in
// advance to pass in.
//
// An explicit variable always wins — CONTRIBUTING.md's local setup and the test harnesses point
// the roles at a database whose owner URL is not theirs to derive from.
function roleUrl(explicit: string | undefined, role: string): string | undefined {
  if (explicit) return explicit;
  const owner = process.env.APP_DATABASE_URL;
  const password = process.env.WAREHOUSD_DATA_ROLE_PASSWORD;
  if (!owner || !password) return undefined;
  return dataRoleUrl(owner, role, password);
}

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
    const dev = roleUrl(process.env.DEV_DATABASE_URL, "warehousd_dev");
    const live = roleUrl(process.env.LIVE_DATABASE_URL, "warehousd_live");
    if (!dev || !live) {
      // Failing here beats connecting to whatever libpq defaults to. `new Pool({ connectionString:
      // undefined })` does not throw — it quietly targets localhost as the OS user, so the fault
      // surfaces later as an unrelated connection error on the first governed query.
      throw new Error(
        "Cannot resolve the data-role database URLs. Set DEV_DATABASE_URL and LIVE_DATABASE_URL, " +
          "or set APP_DATABASE_URL and WAREHOUSD_DATA_ROLE_PASSWORD so they can be derived.",
      );
    }
    const pools = createPools({
      app: process.env.APP_DATABASE_URL!,
      dev,
      live,
      imp: process.env.IMPORT_DATABASE_URL,
      devWrite: roleUrl(process.env.DEV_WRITE_DATABASE_URL, "warehousd_dev_write"),
      liveWrite: roleUrl(process.env.LIVE_WRITE_DATABASE_URL, "warehousd_live_write"),
    });
    cached = {
      pools,
      broker: makeBroker(pools, cfg, embedderFor(cfg)),
      cfg,
      baselineMtime: mtimes.base,
      localMtime: mtimes.local,
    };
  } else {
    // Config changed: rebuild broker with same pools
    cached.broker = makeBroker(cached.pools, cfg, embedderFor(cfg));
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

// The embedder, built from config and injected. Constructing it HERE rather than inside the
// broker is what keeps packages/broker free of an ONNX runtime and of any outbound call — the
// broker declares the `Embedder` interface and consumes it, exactly as it does with `Pools`.
//
// Absent `embedding:` means no embedder, and `search_documents` then refuses `semantic`/`hybrid`
// rather than silently downgrading to a text search.
function embedderFor(cfg: WarehousdConfig): { embedder?: Embedder } {
  if (!cfg.embedding) return {};
  return { embedder: makeEmbedder(cfg.embedding) };
}
