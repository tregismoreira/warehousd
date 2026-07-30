import { defineConfig } from "vitest/config";

// Suites that depend on cluster-global state and so cannot share a Postgres with anything
// running concurrently. They run alone in a second pass — see vitest.serial.config.ts.
//
// - bootstrap.test.ts rotates the warehousd_dev password to prove the escaping round-trips.
//   Roles are cluster-global, so a parallel worker's pool hits that window and fails to
//   authenticate.
// - change-feed.test.ts asserts that an entry is visible immediately after the write. The feed
//   withholds rows until `pg_snapshot_xmin` passes their `xmin` (see `changes` in
//   packages/broker/src/verbs/history.ts) so that `seq` can never be handed out
//   non-monotonically. Transaction ids are cluster-global, so an
//   in-flight transaction in *any other database* on this server holds that watermark down and
//   the entry is — correctly — not yet returned. The feed is right; the assertion needs a quiet
//   cluster.
// - rest-api.integration.test.ts reaches the same feed through `GET /v1/changes` and asserts a
//   just-written entry is present, so it carries change-feed.test.ts's dependency on a quiet
//   cluster without being obviously about the feed. It was missed here and failed roughly one
//   run in two in the parallel pass while passing every time on its own.
export const SERIAL_TESTS = [
  "**/test/bootstrap.test.ts",
  "**/test/change-feed.test.ts",
  "**/test/rest-api.integration.test.ts",
];

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
