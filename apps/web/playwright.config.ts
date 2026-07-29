import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const DB = "postgres://postgres:postgres@127.0.0.1:54330/warehousd_e2e";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  fullyParallel: false, // one database, one dev server
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // `timeout` above is the per-test cap; this is the per-assertion one, which defaults to 5s.
  // The GitHub runner is roughly 3x slower than a dev machine (11m vs 3.5m for this suite), so
  // 5s there buys about 1.5s of local-equivalent budget — not enough for the grant tables,
  // which re-render when their fetch lands. Raising it only affects how long a failing
  // assertion waits before giving up; the 120s per-test cap still bounds the whole run.
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://localhost:8722",
    trace: "retain-on-failure",
    // Taller than the 720px default: the SSO and approval sheets put their action footer
    // below the fold at 720, and Playwright refuses to click an off-viewport element.
    viewport: { width: 1280, height: 1000 },
  },
  webServer: {
    // `next dev`, not a production build: better-auth enables rate limiting outside
    // development (3 sign-ins per 10s per IP), and a suite that signs personas in and out
    // dozens of times trips it within the first file.
    command: "pnpm dev",
    url: "http://localhost:8722/login",
    reuseExistingServer: !process.env.CI,
    timeout: 600_000,
    maxStartupAttempts: 3,
    env: {
      APP_DATABASE_URL: DB,
      DEV_DATABASE_URL: "postgres://warehousd_dev:pw@127.0.0.1:54330/warehousd_e2e",
      LIVE_DATABASE_URL: "postgres://warehousd_live:pw@127.0.0.1:54330/warehousd_e2e",
      IMPORT_DATABASE_URL: "postgres://warehousd_import:pw@127.0.0.1:54330/warehousd_e2e",
      WAREHOUSD_PROJECT_DIR: resolve(__dirname, "../../examples/harbor"),
      WAREHOUSD_DEMO: "true",
      // Throwaway — this database is dropped and rebuilt by scripts/e2e-setup.ts on every run.
      BETTER_AUTH_SECRET: "e2e-secret-at-least-32-chars-long-0000",
      BETTER_AUTH_URL: "http://localhost:8722",
    },
  },
});
