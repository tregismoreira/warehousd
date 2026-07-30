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
  ],
  all: true,
  // Thresholds only on the merge step, never on an individual pass: the serial pass runs three
  // suites, so checking a floor against its partial coverage would fail every time and say nothing.
  // scripts/run-tests.ts sets this for the merge invocation alone.
  //
  // A floor, not a target — it exists to catch a regression, not to block work that has not moved
  // the number. The audit's named blind spots to attack first: refusal branches in the broker
  // verbs, sql/build.ts's operator paths, and oauth/env-scope.ts's rule interactions.
  // Measured on the merged report, 2026-07-30: lines 87.95, statements 87.95, branches 84.77,
  // functions 90.78 (931 tests). Each floor sits ~3 points under its measurement — close enough to
  // catch a real regression, far enough not to trip on one test moving. Raise them when a phase
  // raises the real number; `WAREHOUSD_COVERAGE_MIN` overrides all four for a one-off run.
  ...(process.env.WAREHOUSD_COVERAGE_THRESHOLDS
    ? {
        thresholds: {
          lines: Number(process.env.WAREHOUSD_COVERAGE_MIN ?? 85),
          statements: Number(process.env.WAREHOUSD_COVERAGE_MIN ?? 85),
          branches: Number(process.env.WAREHOUSD_COVERAGE_MIN ?? 82),
          functions: Number(process.env.WAREHOUSD_COVERAGE_MIN ?? 88),
        },
      }
    : {}),
};
