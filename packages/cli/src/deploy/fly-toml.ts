import { IMAGE_REPO } from "../image";
import { type WarehousdConfig } from "@warehousd/broker";

// WAREHOUSD_CLI_VERSION is defined by tsup at build time; fallback to 'latest' in dev mode.
declare const WAREHOUSD_CLI_VERSION: string | undefined;

/**
 * Resolves the base image for the deploy Dockerfile. Prefers cfg.deploy.image, then
 * process.env.WAREHOUSD_IMAGE, then the IMAGE_REPO default with WAREHOUSD_CLI_VERSION.
 * This mirrors how start.ts declares the WAREHOUSD_CLI_VERSION tsup define.
 */
export function resolveBaseImage(cfg: WarehousdConfig): string {
  if (cfg.deploy?.image) {
    return cfg.deploy.image;
  }
  if (process.env.WAREHOUSD_IMAGE) {
    return process.env.WAREHOUSD_IMAGE;
  }
  return `${IMAGE_REPO}:${typeof WAREHOUSD_CLI_VERSION !== "undefined" ? WAREHOUSD_CLI_VERSION : "latest"}`;
}

/**
 * Renders the deploy Dockerfile. The base image runs as USER node (uid 1000), and a /project
 * tree it cannot read fails as "No warehousd.yml in /project" rather than as a permission error.
 * The --chown is required.
 */
export function renderDeployDockerfile(baseImage: string): string {
  return `FROM ${baseImage}
COPY --chown=node:node context /project`;
}

/**
 * Renders the fly.toml configuration. Why these settings:
 *
 * - release_command runs the existing idempotent bootstrap on a one-off machine BEFORE the
 *   release takes traffic, so a failed migration aborts the deploy and the old release keeps
 *   serving.
 * - [processes] app overrides the image CMD (which is `sh -c "entrypoint && next start"`) so
 *   the entrypoint runs ONLY as the release command, not a second time per machine.
 * - WAREHOUSD_DEMO is deliberately ABSENT — its absence is what keeps demo personas from being
 *   seeded.
 * - [[http_service.checks]] hits /api/health, the same endpoint `warehousd status` polls. The
 *   deploy polls it once after the release and then stops looking, so without this nothing
 *   notices a machine that wedges after a healthy release — it stays in rotation serving errors.
 *   grace_period covers boot only: migrations run in release_command, on a one-off machine,
 *   before this one takes traffic.
 */
export function renderFlyToml(o: { appName: string; region: string }): string {
  return `app = "${o.appName}"
primary_region = "${o.region}"

[build]
  dockerfile = "Dockerfile"

[deploy]
  release_command = "pnpm tsx apps/web/scripts/entrypoint.ts"

[env]
  PORT = "8722"
  WAREHOUSD_PROJECT_DIR = "/project"
  NODE_ENV = "production"

[processes]
  app = "pnpm --filter @warehousd/web start"

# Without this Fly provisions its 256MB default, which a Next.js server plus the tsx bootstrap
# OOM-thrashes in — health checks flap and requests hang while the kernel reclaims.
[[vm]]
  memory = "1gb"
  cpu_kind = "shared"
  cpus = 1

[http_service]
  internal_port = 8722
  processes = ["app"]
  force_https = true
  auto_stop_machines = "suspend"
  min_machines_running = 1

[[http_service.checks]]
  path = "/api/health"
  method = "GET"
  interval = "15s"
  timeout = "5s"
  grace_period = "30s"`;
}
