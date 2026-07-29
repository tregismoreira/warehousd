import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { authorizeAndGetCode, pkcePair } from "./helpers/oauth";
import { upsertClientPolicy, requestGrant, approveGrant, loadConfig } from "@warehousd/broker";

// approveGrant validates verbs against the collection's config, and these fixtures grant over
// harbor collections — so that is the config the rules have to be checked against.
const harborCfg = loadConfig(new URL("../../../examples/harbor", import.meta.url).pathname);

import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let miaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("brokerctx");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

async function mintAccessToken(scope: string) {
  const app = getAppPool();
  const reg = await db.auth.api.registerMcpClient({
    body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "BC Client" },
    asResponse: true,
  } as any);
  const { client_id, client_secret } = await reg.json(); // snake_case — RFC 7591
  await upsertClientPolicy(app, client_id, "BC Client", ["env:dev", "env:live"]);
  if (scope.includes("env:live")) {
    const g = await requestGrant(app, { userId: "mia", collection: "people", orgId: "default", env: "live", purposeLabel: "t", allowedFields: ["id"] });
    await approveGrant(app, harborCfg, g, "marcus", { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  }
  const { verifier, challenge } = pkcePair();
  const { code } = await authorizeAndGetCode(db.auth, {
    clientId: client_id, scope, cookie: miaCookie, challenge,
  });
  const tokenRes = await db.auth.api.mcpOAuthToken({
    body: {
      grant_type: "authorization_code", code, redirect_uri: "http://localhost:9999/callback",
      client_id, client_secret, code_verifier: verifier,
    },
    asResponse: true,
  } as any);
  return (await tokenRes.json()).access_token as string;
}

describe("deriveTokenContext", () => {
  it("env:live token → ctx.env='live', ctx.userId=token subject", async () => {
    const { deriveTokenContext } = await import("../lib/broker-context");
    const token = await mintAccessToken("env:live");
    const ctx = await deriveTokenContext(new Request("http://localhost:8722/mcp", {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(ctx).toEqual({ userId: "mia", orgId: "default", env: "live", allowedCollections: null, via: "oauth" });
  });

  it("token with no env scope → adapter resolves dev", async () => {
    const { deriveTokenContext } = await import("../lib/broker-context");
    const token = await mintAccessToken("openid");
    const ctx = await deriveTokenContext(new Request("http://localhost:8722/mcp", {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(ctx).toEqual({ userId: "mia", orgId: "default", env: "dev", allowedCollections: null, via: "oauth" });
  });

  it("invalid/missing token → null", async () => {
    const { deriveTokenContext } = await import("../lib/broker-context");
    const ctx = await deriveTokenContext(new Request("http://localhost:8722/mcp", {
      headers: { authorization: "Bearer not-a-real-token" },
    }));
    expect(ctx).toBeNull();
  });

  it("an env-like body param is never read — only the verified token's scopes matter", async () => {
    const { deriveTokenContext } = await import("../lib/broker-context");
    const token = await mintAccessToken("env:dev");
    const ctx = await deriveTokenContext(new Request("http://localhost:8722/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ env: "live" }),
    }));
    expect(ctx?.env).toBe("dev");
  });
});
