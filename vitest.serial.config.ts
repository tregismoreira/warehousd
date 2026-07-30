import { defineConfig } from "vitest/config";
import { coverage } from "./vitest.coverage";
import { SERIAL_TESTS } from "./vitest.config";

// Second pass of `pnpm test`: the suites that mutate cluster-global state, run on their own.
// globalSetup is shared, but the templates are fingerprinted, so this pass rebuilds nothing.
export default defineConfig({
  test: {
    include: SERIAL_TESTS,
    exclude: ["**/node_modules/**"],
    globalSetup: ["./vitest.global-setup.ts"],
    // Options only — `coverage.enabled` stays false until `--coverage` is passed, so a plain
    // `pnpm test` pays nothing. See vitest.coverage.ts and scripts/run-tests.ts.
    coverage,
    hookTimeout: 60_000,
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
