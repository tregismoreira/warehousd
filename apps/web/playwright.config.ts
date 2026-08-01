import { defineConfig } from "@playwright/test";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(__dirname, "../..");

// Sibling checkouts share the one Postgres container on 54330, so a fixed database name lets a
// suite in the next workspace drop this one's schema out from under it mid-run. Scope it to the
// workspace directory; `scripts/e2e-setup.ts` derives the same slug, so what this connects to is
// what that script provisioned.
const SLUG = basename(ROOT)
  .toLowerCase()
  .replace(/[^a-z0-9_]/g, "_");
const DB_NAME = process.env.WAREHOUSD_E2E_DB ?? `warehousd_e2e_${SLUG}`;
const url = (role: string, pw: string) => `postgres://${role}:${pw}@127.0.0.1:54330/${DB_NAME}`;

// The port has the same collision class, and it is the more dangerous half: a shared database
// corrupts state, but a shared port makes this run *test the other checkout's application* and
// report the result as ours. So the port is derived too, rather than left to a flag someone has
// to remember. FNV-1a over the slug lands in 8800-8899, clear of 8722 (`pnpm dev`), 8723
// (`warehousd start`'s database) and 8780 (Keycloak).
function derivePort(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 8800 + (h % 100);
}

const PORT = Number(process.env.WAREHOUSD_E2E_PORT ?? derivePort(SLUG));
const ORIGIN = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Runs after the webServer below is answering, and builds every page and route handler before
  // the first assertion starts its clock. See the file for why that beats a longer timeout.
  globalSetup: "./e2e/warm-routes.ts",
  timeout: 120_000,
  fullyParallel: false, // one database, one dev server
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // `timeout` above is the per-test cap; this is the per-assertion one, which defaults to 5s.
  // The GitHub runner is roughly 2.5-3x slower than a dev machine (5.3m against 2.0m for this
  // suite, measured either side of the persona sessions in auth.setup.ts), so 5s there buys about
  // 2s of local-equivalent budget — not enough for the grant tables, which re-render when their
  // fetch lands. Raising it only affects how long a failing assertion waits before giving up; the
  // 120s per-test cap still bounds the whole run.
  expect: { timeout: 15_000 },
  // `setup` signs each persona in once and saves its cookie jar; the specs adopt one instead of
  // driving the login form per test. It is a `dependency` rather than more globalSetup so that a
  // filtered run (`playwright test guards.spec.ts`) still gets its sessions, and so that a failure
  // to sign in reports as a failed test rather than as a crash before the run starts.
  //
  // `e2e` keeps the default testMatch, which is *.spec.ts and so never picks up auth.setup.ts.
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts$/ },
    { name: "e2e", dependencies: ["setup"] },
  ],
  use: {
    baseURL: ORIGIN,
    trace: "retain-on-failure",
    // Taller than the 720px default: the SSO and approval sheets put their action footer
    // below the fold at 720, and Playwright refuses to click an off-viewport element.
    viewport: { width: 1280, height: 1000 },
  },
  webServer: {
    // `next dev`, not a production build: better-auth enables rate limiting outside
    // development (3 sign-ins per 10s per IP), and a suite that signs personas in and out
    // dozens of times trips it within the first file.
    // The guard runs before the server: `next dev` silently rebinds to the next free port when
    // the one it was given is busy, which would leave Playwright polling an origin served by
    // someone else's app.
    command: "node ../../scripts/assert-port-free.mjs && pnpm dev",
    url: `${ORIGIN}/login`,
    // Deliberately not the usual `!process.env.CI`. Reuse cannot tell *whose* server answers on
    // the port, so locally it will adopt another checkout's dev server — running this suite
    // against that checkout's code and database, and reporting the result as this one's. With
    // the port derived above there is nothing legitimate to reuse anyway.
    reuseExistingServer: false,
    timeout: 600_000,
    env: {
      WAREHOUSD_APP_PORT: String(PORT),
      APP_DATABASE_URL: url("postgres", "postgres"),
      DEV_DATABASE_URL: url("warehousd_dev", "pw"),
      LIVE_DATABASE_URL: url("warehousd_live", "pw"),
      DEV_WRITE_DATABASE_URL: url("warehousd_dev_write", "pw"),
      LIVE_WRITE_DATABASE_URL: url("warehousd_live_write", "pw"),
      IMPORT_DATABASE_URL: url("warehousd_import", "pw"),
      WAREHOUSD_PROJECT_DIR: resolve(ROOT, "examples/harbor"),
      WAREHOUSD_DEMO: "true",
      // Throwaway — this database is dropped and rebuilt by scripts/e2e-setup.ts on every run.
      BETTER_AUTH_SECRET: "e2e-secret-at-least-32-chars-long-0000",
      BETTER_AUTH_URL: ORIGIN,
    },
  },
});
