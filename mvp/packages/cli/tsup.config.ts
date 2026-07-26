import { defineConfig } from "tsup";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  target: "node22",
  platform: "node",
  clean: true,
  // Inline every dependency, including the unpublished @warehousd/broker workspace package
  // and its yaml/zod/drizzle deps. `pg` stays external: it does runtime feature detection and
  // optional native lookups that do not survive bundling.
  noExternal: [/.*/],
  external: ["pg"],
  banner: { js: "#!/usr/bin/env node" },
  define: {
    WAREHOUSD_CLI_VERSION: JSON.stringify(pkg.version),
  },
});
