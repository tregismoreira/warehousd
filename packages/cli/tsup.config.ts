import { defineConfig } from "tsup";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  // Keyed so the bundle stays dist/index.cjs — the published `bin` path — while the entry moves to
  // program.ts, which holds the commander wiring. src/index.ts is the library half the unit suites
  // import.
  entry: { index: "src/program.ts" },
  format: ["cjs"],
  target: "node22",
  platform: "node",
  clean: true,
  // Inline every dependency, including the unpublished @warehousd/broker workspace package
  // and its yaml/zod deps. `pg` stays external: it does runtime feature detection and
  // optional native lookups that do not survive bundling.
  noExternal: [/.*/],
  external: ["pg"],
  banner: { js: "#!/usr/bin/env node" },
  define: {
    WAREHOUSD_CLI_VERSION: JSON.stringify(pkg.version),
  },
});
