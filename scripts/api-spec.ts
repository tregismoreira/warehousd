// Generates docs/openapi.json and docs/mcp-tools.json.
//
// Every schema here comes from the code that enforces it: request bodies from the broker's
// intent schemas, statuses from restStatus(), MCP tool schemas from the same zod schemas each
// handler parses against. A spec written by hand is a claim; this one is a derivation, and
// apps/web/test/api-spec.test.ts fails when it stops matching.
//
// `--check` regenerates in memory and exits 1 with a diff instead of writing. The document
// builders themselves live in apps/web/lib/api-schema/{generate,mcp-manifest}.ts, not here — those
// modules resolve `zod` through apps/web's own node_modules (it declares zod as a dependency);
// this script sits at the repo root, where a bare `import "zod"` would not resolve without adding
// zod as a root dependency. Importing only the builder functions, never `zod` itself, avoids that
// without one.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import prettier from "prettier";
import { buildOpenApiDoc } from "../apps/web/lib/api-schema/generate";
import { buildMcpManifest } from "../apps/web/lib/api-schema/mcp-manifest";

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const OPENAPI_PATH = path.resolve(ROOT, "docs/openapi.json");
const MCP_TOOLS_PATH = path.resolve(ROOT, "docs/mcp-tools.json");

async function formatJson(doc: unknown, outPath: string): Promise<string> {
  const cfg = await prettier.resolveConfig(outPath);
  return prettier.format(JSON.stringify(doc), { ...cfg, parser: "json", filepath: outPath });
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const targets: { path: string; text: string }[] = [
    { path: OPENAPI_PATH, text: await formatJson(buildOpenApiDoc(), OPENAPI_PATH) },
    { path: MCP_TOOLS_PATH, text: await formatJson(buildMcpManifest(), MCP_TOOLS_PATH) },
  ];

  if (check) {
    let stale = false;
    for (const { path: p, text } of targets) {
      const current = existsSync(p) ? readFileSync(p, "utf8") : null;
      if (current !== text) {
        console.error(
          `${path.relative(ROOT, p)} is out of date. Run \`pnpm spec\` and commit the result.`,
        );
        stale = true;
      }
    }
    if (stale) process.exit(1);
    console.log("docs/openapi.json and docs/mcp-tools.json are up to date.");
    return;
  }

  for (const { path: p, text } of targets) writeFileSync(p, text);
  console.log("wrote docs/openapi.json and docs/mcp-tools.json");
}

// A bare `main()` left a failure as an unhandled rejection rather than a clear message and a
// non-zero exit — see scripts/dev-bootstrap.ts for the same fix.
main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
