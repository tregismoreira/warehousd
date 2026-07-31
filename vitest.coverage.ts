import type { ViteUserConfig } from "vitest/config";

type Coverage = NonNullable<NonNullable<ViteUserConfig["test"]>["coverage"]>;

// Shared by the parallel and serial passes so their reports are comparable and mergeable.
//
// `pnpm test` is two vitest processes (see scripts/run-tests.ts), and each would otherwise write a
// complete report over the other's — leaving the serial pass's three suites as the only measured
// code. Both passes emit raw v8 coverage into the same directory instead, and
// `scripts/run-tests.ts` calls `vitest run --merge-reports` once at the end to turn the pair into a
// single report. A number that describes half the suite is worse than no number.
export const coverage: Coverage = {
  provider: "v8",
  // text for the terminal, lcov for CI and editor gutters, json-summary for the threshold check.
  reporter: ["text", "lcov", "json-summary"],
  reportsDirectory: "coverage",
  // What the audit was about, so what coverage is measured against. Config, generated DDL and the
  // UI are deliberately out: the invariant this repo promises lives in the broker and in the two
  // adapters that reach it.
  include: [
    "packages/broker/src/**/*.ts",
    "packages/cli/src/**/*.ts",
    "apps/web/lib/**/*.ts",
    "apps/web/app/**/route.ts",
  ],
  exclude: [
    "**/*.d.ts",
    // Schema definitions and generated DDL strings: executed as data, not as branches.
    "packages/broker/src/db/schema.ts",
    // The CLI's container orchestration. These are covered — thoroughly — by
    // packages/cli/test/e2e/lifecycle.e2e.test.ts, which drives the built bundle as a subprocess
    // against real Docker, and that suite deliberately collects no coverage (see
    // vitest.e2e.config.ts): v8 would measure the spawner, not the spawned. Measuring them here
    // therefore reports 0% for code that is tested, and no test written in the measured suites can
    // move it without re-implementing the e2e suite as mocks. vitest 2 hid this by finding no
    // branches in these files at all and calling that 100%.
    "packages/cli/src/docker.ts",
    "packages/cli/src/start.ts",
    "packages/cli/src/stop.ts",
    "packages/cli/src/status.ts",
  ],
  // No `all: true` — vitest 4 removed it. Setting `include` is now what pulls in files no test
  // touched, which is the same thing this asked for: a file with no test at all has to count as
  // zero, or the number measures the tested subset and flatters it.
  //
  // Thresholds only on the merge step, never on an individual pass: the serial pass runs three
  // suites, so checking a floor against its partial coverage would fail every time and say nothing.
  // scripts/run-tests.ts sets this for the merge invocation alone.
  //
  // A floor, not a target — it exists to catch a regression, not to block work that has not moved
  // the number. The audit's named blind spots to attack first: refusal branches in the broker
  // verbs, sql/build.ts's operator paths, and oauth/env-scope.ts's rule interactions.
  // Measured on the merged report, 2026-07-31: lines 91.56, statements 88.54, branches 80.60,
  // functions 94.80 (949 tests). Each floor sits ~3 points under its measurement — close enough to
  // catch a real regression, far enough not to trip on one test moving. Raise them when a phase
  // raises the real number; `WAREHOUSD_COVERAGE_MIN` overrides all four for a one-off run.
  //
  // Lines, statements and functions are the floors this repo has always had. Branches is not: it
  // was 82 and is 77, and that is worth stating plainly rather than leaving to be discovered.
  //
  // @vitest/coverage-v8 2 → 4 changed what counts as a branch. It now sees ~113 branch sites that
  // v2 did not count at all — `??` fallbacks and `?.` chains, most of them on values a schema
  // default or a NOT NULL column already guarantees — so the denominator grew with branches that
  // no honest test can take. Same suite, same source: branches read 84.77 under v2 and 80.60 under
  // v4. The gap is arithmetic, not lost testing.
  //
  // The 18 tests in proposal-decision-refusals.test.ts and read-path-refusals.test.ts were written
  // against this: the broker's own branch coverage is 83.8%, and what remains below the old floor
  // is concentrated in apps/web/app/api (68.4%), whose uncovered branches are overwhelmingly query
  // parameter defaulting. Those routes stay measured — they carry grants, API keys and SSO
  // registration, and dropping them from `include` to recover a number would be measuring less and
  // calling it measuring better.
  ...(process.env.WAREHOUSD_COVERAGE_THRESHOLDS
    ? {
        thresholds: {
          lines: Number(process.env.WAREHOUSD_COVERAGE_MIN ?? 85),
          statements: Number(process.env.WAREHOUSD_COVERAGE_MIN ?? 85),
          branches: Number(process.env.WAREHOUSD_COVERAGE_MIN ?? 77),
          functions: Number(process.env.WAREHOUSD_COVERAGE_MIN ?? 88),
        },
      }
    : {}),
};
