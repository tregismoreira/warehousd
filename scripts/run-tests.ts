// `pnpm test` is two vitest passes: everything in parallel, then the suites that need a quiet
// Postgres cluster (SERIAL_TESTS in vitest.config.ts). A `pnpm a && pnpm b` script cannot carry
// arguments — pnpm appends them to the *last* command, so `pnpm test some.test.ts` ran the whole
// parallel pass unfiltered and then failed the serial one on a filter it could never match.
// Hence this wrapper: it forwards argv to the pass that can actually satisfy it.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { SERIAL_TESTS } from "../vitest.config";

const args = process.argv.slice(2);
// "**/test/change-feed.test.ts" -> "change-feed.test"
const serialNames = SERIAL_TESTS.map((p) => p.replace("**/test/", "").replace(/\.ts$/, ""));

const filters = args.filter((a) => !a.startsWith("-"));
// A filter naming a serial suite must go to the serial pass and only there: the parallel config
// excludes those files, so it would match nothing and fail. Matched in both directions so that a
// bare `change-feed` and a full path both land. Keeping `.test` in the name is what stops
// `entrypoint-bootstrap.integration.test` from being read as `bootstrap.test`.
const isSerial = (f: string) => serialNames.some((n) => f.includes(n) || n.includes(f));
const wantsSerial = filters.length === 0 || filters.some(isSerial);
const wantsParallel = filters.length === 0 || !wantsSerial;

// Two vitest processes each writing a full coverage report means the second overwrites the first,
// leaving the serial pass's three suites as the only measured code. So under `--coverage` each pass
// writes a *blob* report instead and a third invocation merges the pair into one report — the same
// mechanism vitest uses for sharded runs. A coverage number that describes half the suite is worse
// than no number.
const withCoverage = args.some((a) => a === "--coverage" || a.startsWith("--coverage."));
const BLOBS = ".vitest-reports";
if (withCoverage) rmSync(BLOBS, { recursive: true, force: true });

const blobArgs = (name: string) =>
  withCoverage ? ["--reporter=blob", `--outputFile=${BLOBS}/${name}.json`] : [];

const passes: string[][] = [];
if (wantsParallel) passes.push(["run", ...args, ...blobArgs("parallel")]);
if (wantsSerial)
  passes.push(["run", "--config", "vitest.serial.config.ts", ...args, ...blobArgs("serial")]);
// Reports only — `--mergeReports` makes vitest replay the blobs rather than run anything, which is
// also the only place the coverage thresholds are checked (see vitest.coverage.ts).
if (withCoverage) passes.push(["run", `--mergeReports=${BLOBS}`, "--coverage"]);

for (const pass of passes) {
  const isMerge = pass.includes(`--mergeReports=${BLOBS}`);
  const r = spawnSync("vitest", pass, {
    stdio: "inherit",
    env: isMerge ? { ...process.env, WAREHOUSD_COVERAGE_THRESHOLDS: "1" } : process.env,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
}
