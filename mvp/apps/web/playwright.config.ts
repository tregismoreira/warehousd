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
  use: { baseURL: "http://localhost:8722", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:8722/login",
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    maxStartupAttempts: 3,
    env: {
      APP_DATABASE_URL: DB,
      DEV_DATABASE_URL: "postgres://warehousd_dev:pw@127.0.0.1:54330/warehousd_e2e",
      LIVE_DATABASE_URL: "postgres://warehousd_live:pw@127.0.0.1:54330/warehousd_e2e",
      IMPORT_DATABASE_URL: "postgres://warehousd_import:pw@127.0.0.1:54330/warehousd_e2e",
      WAREHOUSD_PROJECT_DIR: resolve(__dirname, "../../examples/meridian"),
      WAREHOUSD_DEMO: "true",
    },
  },
});
