import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { authorizeAndGetCode, pkcePair } from "./helpers/oauth";
import { upsertClientPolicy } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";
import mcpToolsCommitted from "../../../docs/mcp-tools.json";

// This is what makes docs/mcp-tools.json a fact about the running server rather than a claim
// about it: a real tools/list call, through the real route handler, deep-equal against the
// committed manifest.

let db: Awaited<ReturnType<typeof setupWebDb>>;
let miaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("mcpmanifest");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
}, 60_000);
afterAll(async () => {
  await db?.end();
});

// Mirrors apps/web/test/mcp-endpoint.integration.test.ts's token setup.
async function mintAccessToken(scope: string) {
  const app = getAppPool();
  const reg = await db.auth.api.registerMcpClient({
    body: {
      redirect_uris: ["http://localhost:9999/callback"],
      client_name: "MCP Manifest Test Client",
    },
    asResponse: true,
  } as any);
  const { client_id, client_secret } = await reg.json();
  await upsertClientPolicy(app, client_id, "MCP Manifest Test Client", ["env:dev", "env:live"]);
  const { verifier, challenge } = pkcePair();
  const { code } = await authorizeAndGetCode(db.auth, {
    clientId: client_id,
    scope,
    cookie: miaCookie,
    challenge,
  });
  const tokenRes = await db.auth.api.mcpOAuthToken({
    body: {
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:9999/callback",
      client_id,
      client_secret,
      code_verifier: verifier,
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
  const jsonLine = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .find((l) => l.startsWith("data: "))
        ?.slice(6);
  return { status: res.status, body: jsonLine ? JSON.parse(jsonLine) : null };
}

describe("mcp-manifest", () => {
  it("tools/list deep-equals the committed docs/mcp-tools.json", async () => {
    const token = await mintAccessToken("env:dev");
    const { body } = await rpc(token, "tools/list");
    expect(body.result.tools).toEqual(mcpToolsCommitted.tools);
  });

  it("advertises the revision tools with their required properties", async () => {
    const token = await mintAccessToken("env:dev");
    const { body } = await rpc(token, "tools/list");
    const tools: { name: string; inputSchema: { required?: string[] } }[] = body.result.tools;
    expect(tools.map((t) => t.name)).toContain("list_revisions");
    expect(tools.map((t) => t.name)).toContain("get_revision");
    expect(tools.map((t) => t.name)).toContain("diff_revisions");
    const get = tools.find((t) => t.name === "get_revision");
    expect(get?.inputSchema.required?.slice().sort()).toEqual(["collection", "id", "rev"]);
    const diff = tools.find((t) => t.name === "diff_revisions");
    expect(diff?.inputSchema.required?.slice().sort()).toEqual(["collection", "from", "id", "to"]);
  });
});
