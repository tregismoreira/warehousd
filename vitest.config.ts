import { defineConfig } from "vitest/config";

// Suites that mutate cluster-global state and so cannot share a Postgres with anything running
// concurrently. bootstrap.test.ts rotates the warehousd_dev password to prove the escaping
// round-trips; roles are cluster-global, so a parallel worker's pool would hit that window and
// fail to authenticate. These run alone in a second pass — see vitest.serial.config.ts.
export const SERIAL_TESTS = ["**/test/bootstrap.test.ts"];

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"],
    exclude: ["**/e2e/**", "**/node_modules/**", ...SERIAL_TESTS],
    globalSetup: ["./vitest.global-setup.ts"],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // Every test file provisions its own database (label + pid) and the role DDL that used to
    // race now runs once in globalSetup, so files can go in parallel against the one Postgres.
    // Forks, not threads: tests set APP_DATABASE_URL and friends on process.env.
    fileParallelism: true,
    pool: "forks",
    poolOptions: {
      // Capped, and overridable: sibling Conductor workspaces share this machine and this
      // Postgres. Raise max_connections in docker-compose.test.yml before raising this.
      forks: { minForks: 1, maxForks: Number(process.env.WAREHOUSD_TEST_WORKERS ?? 4) },
    },
  },
});
