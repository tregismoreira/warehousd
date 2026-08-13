import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// apps/web/app/v1/openapi.json/route.ts imports docs/openapi.json directly, so it has to survive
// into the Docker build context (apps/web/Dockerfile's builder stage runs `next build` against a
// `COPY . .` of the repo root). This once broke silently: `.dockerignore` excluded `docs` wholesale
// — a directory nobody expected build output to read from — and nothing caught it short of a full
// `docker build` actually failing in CI. This test is the fast version of that check: it does not
// reimplement Docker's ignore-pattern matching, it only rules out the specific shape of exclusion
// that caused the incident (a pattern that drops the whole `docs` directory).
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../..");

describe(".dockerignore", () => {
  it("does not exclude the docs/ directory wholesale", () => {
    const lines = readFileSync(path.join(REPO_ROOT, ".dockerignore"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    const wholesaleDocsPatterns = ["docs", "docs/", "docs/**", "**/docs", "**/docs/**"];
    const matches = lines.filter((l) => wholesaleDocsPatterns.includes(l));
    expect(matches).toEqual([]);
  });

  it("the two generated JSON files the app reads at build/run time survive a literal *.md exclusion", () => {
    const lines = readFileSync(path.join(REPO_ROOT, ".dockerignore"), "utf8")
      .split("\n")
      .map((l) => l.trim());

    // docs/openapi.json is imported by apps/web/app/v1/openapi.json/route.ts; docs/mcp-tools.json
    // is not read at runtime today, but is generated alongside it by the same `pnpm spec` step and
    // is cheap to keep available. Neither is markdown, so `*.md` must not (and today does not)
    // touch them — this only pins that nobody adds a line naming either file directly.
    const forbidden = ["docs/openapi.json", "docs/mcp-tools.json"];
    const matches = lines.filter((l) => forbidden.includes(l));
    expect(matches).toEqual([]);
  });
});
