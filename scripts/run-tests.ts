// `pnpm test` is two vitest passes: everything in parallel, then the suites that need a quiet
// Postgres cluster (SERIAL_TESTS in vitest.config.ts). A `pnpm a && pnpm b` script cannot carry
// arguments — pnpm appends them to the *last* command, so `pnpm test some.test.ts` ran the whole
// parallel pass unfiltered and then failed the serial one on a filter it could never match.
// Hence this wrapper: it forwards argv to the pass that can actually satisfy it.
import { spawnSync } from "node:child_process";
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

const passes: string[][] = [];
if (wantsParallel) passes.push(["run", ...args]);
if (wantsSerial) passes.push(["run", "--config", "vitest.serial.config.ts", ...args]);

for (const pass of passes) {
  const r = spawnSync("vitest", pass, { stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
}
