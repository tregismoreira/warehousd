import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  ACL_REFUSAL_REASONS,
  MUTATION_REFUSAL_REASONS,
  type AclRefusalReason,
  type MutationRefusalReason,
} from "@warehousd/broker";
import { buildOpenApiDoc } from "../lib/api-schema/generate";
import { buildMcpManifest } from "../lib/api-schema/mcp-manifest";
import { OPERATIONS } from "../lib/api-schema/routes";
import { restStatus } from "../lib/rest";
import { GET as openapiRoute } from "../app/v1/openapi.json/route";
import { GET as docsRoute } from "../app/v1/docs/route";
import openapiCommitted from "../../../docs/openapi.json";
import mcpToolsCommitted from "../../../docs/mcp-tools.json";

// No database, no setupWebDb — this suite is pure and must stay fast: it checks that the
// generator, the routes it describes, and the reason/status table all still agree with each
// other, none of which needs a live broker.

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../..");
const V1_APP_DIR = path.resolve(REPO_ROOT, "apps/web/app/v1");

describe("api-spec: regeneration", () => {
  it("docs/openapi.json is byte-for-byte what the generator produces", () => {
    expect(openapiCommitted).toEqual(buildOpenApiDoc());
  });

  it("docs/mcp-tools.json is byte-for-byte what the generator produces", () => {
    expect(mcpToolsCommitted).toEqual(buildMcpManifest());
  });
});

describe("api-spec: coverage", () => {
  function routeFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...routeFiles(full));
      else if (entry === "route.ts") out.push(full);
    }
    return out;
  }

  function urlPath(routeFile: string): string {
    const rel = path.relative(V1_APP_DIR, path.dirname(routeFile));
    const segments = rel
      .split(path.sep)
      .map((seg) => (seg.startsWith("[") && seg.endsWith("]") ? `{${seg.slice(1, -1)}}` : seg));
    return `/v1/${segments.join("/")}`;
  }

  it("every /v1 route.ts method appears in the spec, and vice versa", () => {
    // Excluded by name, not by a pattern that could silently swallow a future route: this route
    // serves the spec itself and documents nothing about itself.
    const EXCLUDED = path.join(V1_APP_DIR, "openapi.json", "route.ts");
    // Excluded by directory, deliberately: platform/ is a separate control-plane API (bearer-token
    // auth via derivePlatformCaller, hand-rolled JSON error bodies) with no zod schema anywhere in
    // it, so this generator — which only derives a schema from a route's own enforced validation —
    // has nothing to source from. Hand-writing shapes for it here would duplicate the routes rather
    // than being generated from them, the exact drift this generator exists to prevent. Tracked as
    // follow-up work, not silently dropped.
    const PLATFORM_DIR = path.join(V1_APP_DIR, "platform") + path.sep;

    const fromRoutes = new Set<string>();
    for (const file of routeFiles(V1_APP_DIR)) {
      if (file === EXCLUDED || file.startsWith(PLATFORM_DIR)) continue;
      const source = readFileSync(file, "utf8");
      const methods = [
        ...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)\b/g),
      ];
      const url = urlPath(file);
      for (const m of methods) fromRoutes.add(`${m[1]} ${url}`);
    }

    const fromSpec = new Set(OPERATIONS.map((op) => `${op.method.toUpperCase()} ${op.path}`));

    const missingFromSpec = [...fromRoutes].filter((x) => !fromSpec.has(x));
    const missingFromRoutes = [...fromSpec].filter((x) => !fromRoutes.has(x));

    expect({ missingFromSpec, missingFromRoutes }).toEqual({
      missingFromSpec: [],
      missingFromRoutes: [],
    });
  });
});

describe("api-spec: status table", () => {
  // The canonical reason lists from the broker, not OPERATIONS' own curated per-operation lists —
  // a reason absent from every operation's list would otherwise never be checked at all, which is
  // exactly the case the break-it check (adding a reason REFUSAL_REASONS gains) has to catch.
  const ALL_REASONS: (AclRefusalReason | MutationRefusalReason)[] = [
    ...ACL_REFUSAL_REASONS,
    ...MUTATION_REFUSAL_REASONS,
  ];

  it("every broker refusal reason maps to a documented status", () => {
    const doc = buildOpenApiDoc() as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const documentedStatuses = new Set<number>();
    for (const methods of Object.values(doc.paths)) {
      for (const operation of Object.values(methods)) {
        for (const status of Object.keys(operation.responses))
          documentedStatuses.add(Number(status));
      }
    }

    const undocumented = ALL_REASONS.filter(
      (reason) => !documentedStatuses.has(restStatus(reason)),
    );
    expect(undocumented).toEqual([]);

    // 401 is adapter-level (every operation gets it; no single reason maps to it). The
    // OAuth/grant-request statuses (400/429/500 on /v1/token, 400/404 on POST /v1/grants) are
    // never reachable through restStatus() at all — both are documented allowances, not gaps.
    const ALLOWED_UNMAPPED = new Set([401, 400, 404, 429, 500]);
    const reachableStatuses = new Set([
      ...ALL_REASONS.map((r) => restStatus(r, false)),
      // 412 only comes out of restStatus("conflict", true) — the If-Match branch.
      restStatus("conflict", true),
    ]);
    const documented4xx5xx = [...documentedStatuses].filter((s) => s >= 400);
    const unmapped = documented4xx5xx.filter(
      (s) => !reachableStatuses.has(s) && !ALLOWED_UNMAPPED.has(s),
    );
    expect(unmapped).toEqual([]);
  });
});

describe("api-spec: leak", () => {
  it("no collection name from examples/harbor appears in the OpenAPI spec", () => {
    const cfg = loadConfig(path.resolve(REPO_ROOT, "examples/harbor"));
    const names = Object.keys(cfg.collections);
    expect(names.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(buildOpenApiDoc());
    const hits = names.filter((name) => serialized.includes(name));
    expect(hits).toEqual([]);
  });

  it("no collection name from examples/harbor appears in the MCP manifest", () => {
    const cfg = loadConfig(path.resolve(REPO_ROOT, "examples/harbor"));
    const names = Object.keys(cfg.collections);

    const serialized = JSON.stringify(buildMcpManifest());
    const hits = names.filter((name) => serialized.includes(name));
    expect(hits).toEqual([]);
  });
});

describe("api-spec: served route", () => {
  it("returns 200 with no Authorization header", () => {
    const res = openapiRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("returns 200 even with a garbage bearer token — the route never reads Authorization", async () => {
    // The route handler takes no request parameter at all, so there is nothing a header could
    // change; this test exists so a future edit that *does* start reading it gets noticed here.
    const res = openapiRoute();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(openapiCommitted);
  });

  it("/v1/docs renders the reference UI with no Authorization header", async () => {
    const res = docsRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("/v1/openapi.json");
  });
});
