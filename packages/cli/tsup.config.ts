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
  // Inline every dependency, including the unpublished @warehousd/broker and
  // @warehousd/providers workspace packages and their yaml/zod deps.
  //
  // Four stay external. `pg` does runtime feature detection and optional native lookups that do
  // not survive bundling. The document parsers and the ONNX runtime are loaded through dynamic
  // `import()` and are large, optional and platform-sensitive — bundling them would inline
  // megabytes into a CLI that mostly never touches a PDF, and @huggingface/transformers ships
  // native `.node` binaries that cannot be inlined at all.
  noExternal: [/.*/],
  external: [
    "pg",
    "unpdf",
    "mammoth",
    // The ONNX runtime and its native .node binaries. Listed alongside the package that pulls
    // them in because esbuild follows the transitive import even when the parent is external,
    // and inlining a platform-specific binary into a cross-platform CLI bundle cannot work.
    "@huggingface/transformers",
    "onnxruntime-node",
    "onnxruntime-web",
    "onnxruntime-common",
    "sharp",
  ],
  banner: { js: "#!/usr/bin/env node" },
  define: {
    WAREHOUSD_CLI_VERSION: JSON.stringify(pkg.version),
  },
});
