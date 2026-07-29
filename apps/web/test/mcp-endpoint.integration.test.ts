import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { authorizeAndGetCode, pkcePair } from "./helpers/oauth";
import { upsertClientPolicy, requestGrant, approveGrant } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let miaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("mcpendpoint");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

async function mintAccessToken(scope: string) {
  const app = getAppPool();
  const reg = await db.auth.api.registerMcpClient({
    body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "MCP Endpoint Test Client" },
    asResponse: true,
  } as any);
  const { client_id, client_secret } = await reg.json();
  await upsertClientPolicy(app, client_id, "MCP Endpoint Test Client", ["env:dev", "env:live"]);
  const { verifier, challenge } = pkcePair();
  const { code } = await authorizeAndGetCode(db.auth, { clientId: client_id, scope, cookie: miaCookie, challenge });
  const tokenRes = await db.auth.api.mcpOAuthToken({
    body: {
      grant_type: "authorization_code", code, redirect_uri: "http://localhost:9999/callback",
      client_id, client_secret, code_verifier: verifier,
    },
    asResponse: true,
  } as any);
  return (await tokenRes.json()).access_token as string;
}

function rpcRequest(token: string, body: unknown) {
  return new Request("http://localhost:8722/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

async function rpc(token: string, method: string, params?: unknown) {
  const { POST } = await import("../app/mcp/route");
  const res = await POST(rpcRequest(token, { jsonrpc: "2.0", id: 1, method, params }));
  const text = await res.text();
  // enableJsonResponse defaults to false (SSE), so a JSON-response client still gets a single
  // "data: {...}" event for a non-streaming call; parse whichever shape comes back.
  const jsonLine = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
  return { status: res.status, body: jsonLine ? JSON.parse(jsonLine) : null };
}

describe("/mcp endpoint", () => {
  it("rejects requests with no token", async () => {
    const { POST } = await import("../app/mcp/route");
    const res = await POST(new Request("http://localhost:8722/mcp", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });

  it("returns 401 with WWW-Authenticate header when unauthenticated", async () => {
    const { POST } = await import("../app/mcp/route");
    const res = await POST(new Request("http://localhost:8722/mcp", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("WWW-Authenticate");
    expect(wwwAuth).toBeDefined();
    expect(wwwAuth).toContain("Bearer resource_metadata=");
    expect(wwwAuth).toContain("/.well-known/oauth-protected-resource");
  });

  it("/.well-known/oauth-protected-resource returns 200 with valid metadata", async () => {
    const { GET } = await import("../app/.well-known/oauth-protected-resource/route");
    const res = await GET(new Request("http://localhost:8722/.well-known/oauth-protected-resource"));
    expect(res.status).toBe(200);
    const metadata = await res.json();
    expect(metadata.resource).toBeDefined();
    expect(Array.isArray(metadata.authorization_servers)).toBe(true);
    expect(metadata.authorization_servers.length).toBeGreaterThan(0);
    expect(Array.isArray(metadata.scopes_supported)).toBe(true);
  });

  it("/.well-known/oauth-authorization-server returns 200 with valid OIDC metadata", async () => {
    const { GET } = await import("../app/.well-known/oauth-authorization-server/route");
    const res = await GET(new Request("http://localhost:8722/.well-known/oauth-authorization-server"));
    expect(res.status).toBe(200);
    const metadata = await res.json();
    expect(metadata).toBeDefined();
    // OIDC metadata must have certain required fields
    expect(metadata.issuer).toBeDefined();
    expect(metadata.token_endpoint).toBeDefined();
    expect(metadata.authorization_endpoint).toBeDefined();
  });

  it("list_collections returns names+descriptions only", async () => {
    const token = await mintAccessToken("env:dev");
    const { status, body } = await rpc(token, "tools/call", { name: "list_collections", arguments: {} });
    expect(status).toBe(200);
    const out = JSON.parse(body.result.content[0].text);
    expect(Array.isArray(out)).toBe(true);
    for (const c of out) expect(Object.keys(c).sort()).toEqual(["description", "name"]);
  });

  it("describe_collection is grant-filtered", async () => {
    const app = getAppPool();
    const g = await requestGrant(app, { userId: "mia", collection: "people", env: "dev", purposeLabel: "t", allowedFields: ["id"] });
    await approveGrant(app, g, "marcus", { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    const token = await mintAccessToken("env:dev");
    const { body } = await rpc(token, "tools/call", { name: "describe_collection", arguments: { name: "people" } });
    const out = JSON.parse(body.result.content[0].text);
    expect(out.fields.map((f: { name: string }) => f.name)).toEqual(["id"]);
  });

  it("query_collection refuses hostile intents with a reason code, zero canary leakage", async () => {
    const token = await mintAccessToken("env:dev");
    // "home_address" is a real field on `people` (posture: deny in warehousd.yml) with no
    // grant issued in this test — exercises the deny path without needing a grant fixture.
    const { body } = await rpc(token, "tools/call", {
      name: "query_collection",
      arguments: { collection: "people", fields: ["home_address"] },
    });
    const out = JSON.parse(body.result.content[0].text);
    expect(out.ok).toBe(false);
    expect(["unknown_field", "no_grant", "field_denied"]).toContain(out.reason);
    expect(JSON.stringify(out)).not.toMatch(/canary/i);
    expect(out.hint).toContain("request_access");
  });

  it("search_documents refuses an ungranted collection with a hint (grant-filtering entry point)", async () => {
    const token = await mintAccessToken("env:dev");
    // `policies` is a `type: file` collection in examples/harbor/warehousd.yml. No grant
    // exists in this test, so this exercises the deny-by-default path — same boundary the unit
    // tests in mcp-tools.test.ts already cover; a real successful search against live synthetic/
    // indexed content is out of scope here since apps/web's test harness doesn't provision
    // DEV_DATABASE_URL/LIVE_DATABASE_URL or seeded data (see packages/broker's own
    // search-documents.test.ts for full data-correctness coverage of _rank/document_seq).
    const { body } = await rpc(token, "tools/call", {
      name: "search_documents", arguments: { collection: "policies", q: "policy" },
    });
    const out = JSON.parse(body.result.content[0].text);
    expect(out.ok).toBe(false);
    expect(out.hint).toContain("request_access");
  });

  it("request_access produces a pending grant visible to Marcus", async () => {
    const token = await mintAccessToken("env:dev");
    // `salaries` is a real, sensitive collection in the fixture — requestGrant itself does not
    // validate the collection against config, but using a real name keeps the test realistic.
    const { body } = await rpc(token, "tools/call", {
      name: "request_access", arguments: { collection: "salaries", purpose: "budget review" },
    });
    const out = JSON.parse(body.result.content[0].text);
    expect(out.ok).toBe(true);
    const row = await getAppPool().query(`select status from app.grants where id = $1`, [out.requestId]);
    expect(row.rows[0].status).toBe("pending");
  });

  it("tools/list returns all five tools", async () => {
    const token = await mintAccessToken("env:dev");
    const { body } = await rpc(token, "tools/list");
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "describe_collection", "list_collections", "query_collection", "request_access", "search_documents",
    ]);
  });
});
