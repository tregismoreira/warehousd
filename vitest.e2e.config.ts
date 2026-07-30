import { defineConfig } from "vitest/config";

// No `coverage` here, unlike vitest.config.ts and vitest.serial.config.ts. This suite drives the
// *built* CLI bundle as a subprocess against real Docker containers, so what it exercises runs in
// another process from another artifact — v8 coverage of this process would measure the spawner,
// not the thing under test. The omission is deliberate rather than an oversight.
//
// It also carries no globalSetup, so the template databases and the sweep in
// vitest.global-setup.ts do not apply: this suite creates no `wh_*` clones.
export default defineConfig({
  test: {
    include: ["packages/cli/test/e2e/**/*.e2e.test.ts"],
    hookTimeout: 600_000,
    testTimeout: 600_000,
    fileParallelism: false,
  },
});
