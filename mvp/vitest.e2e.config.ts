import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/cli/test/e2e/**/*.e2e.test.ts"],
    hookTimeout: 600_000,
    testTimeout: 600_000,
    fileParallelism: false,
  },
});
