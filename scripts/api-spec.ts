// Generates docs/openapi.json (and, from Phase 3 on, docs/mcp-tools.json).
//
// Every schema here comes from the code that enforces it: request bodies from the broker's
// intent schemas, statuses from restStatus(), MCP tool schemas from the same zod schemas each
// handler parses against. A spec written by hand is a claim; this one is a derivation, and
// apps/web/test/api-spec.test.ts fails when it stops matching.
//
// `--check` regenerates in memory and exits 1 with a diff instead of writing. The document
// builder itself lives in apps/web/lib/api-schema/generate.ts, not here — that module resolves
// `zod` through apps/web's own node_modules (it declares zod as a dependency); this script sits
// at the repo root, where a bare `import "zod"` would not resolve without adding zod as a root
// dependency. Importing only the builder function, never `zod` itself, avoids that without one.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import prettier from "prettier";
import { buildOpenApiDoc } from "../apps/web/lib/api-schema/generate";

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const OPENAPI_PATH = path.resolve(ROOT, "docs/openapi.json");

async function formatJson(doc: unknown, outPath: string): Promise<string> {
  const cfg = await prettier.resolveConfig(outPath);
  return prettier.format(JSON.stringify(doc), { ...cfg, parser: "json", filepath: outPath });
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const openapiText = await formatJson(buildOpenApiDoc(), OPENAPI_PATH);

  if (check) {
    const current = existsSync(OPENAPI_PATH) ? readFileSync(OPENAPI_PATH, "utf8") : null;
    if (current !== openapiText) {
      console.error("docs/openapi.json is out of date. Run `pnpm spec` and commit the result.");
      process.exit(1);
    }
    console.log("docs/openapi.json is up to date.");
    return;
  }

  writeFileSync(OPENAPI_PATH, openapiText);
  console.log("wrote docs/openapi.json");
}

// A bare `main()` left a failure as an unhandled rejection rather than a clear message and a
// non-zero exit — see scripts/dev-bootstrap.ts for the same fix.
main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
