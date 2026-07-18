import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    fileParallelism: false, // integration tests share one Postgres
  },
});
