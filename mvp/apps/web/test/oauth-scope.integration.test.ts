import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { authorizeAndGetCode, pkcePair } from "./helpers/oauth";
import { upsertClientPolicy, approveGrant, requestGrant } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let miaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("oauthscope");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

// Exchanges an authorization code for a token, returning the granted scope — the scope
// intersection is invisible at the authorize step (no consent screen echoes it back and
// Better Auth doesn't put it in the redirect URL); the token response is the only place it's
// observable.
async function exchangeCodeForScope(clientId: string, clientSecret: string, code: string, verifier: string) {
  const tokenRes = await db.auth.api.mcpOAuthToken({
    body: {
      grant_type: "authorization_code", code, redirect_uri: "http://localhost:9999/callback",
      client_id: clientId, client_secret: clientSecret, code_verifier: verifier,
    },
    asResponse: true,
  } as any);
  const body = await tokenRes.json();
  return body.scope as string;
}

describe("rule 1: dev-only client requesting env:live gets only env:dev", () => {
  it("rewrites the authorize query's scope before the code is ever issued", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Dev Only Client" },
      asResponse: true,
    } as any);
    const { client_id, client_secret } = await reg.json();
    // Force the dev-only policy (DCR default is {env:dev,env:live} — Task 8; here we
    // simulate a manually-created client's policy directly, since manual creation is Task 9).
    const app = getAppPool();
    await upsertClientPolicy(app, client_id, "Dev Only Client", ["env:dev"]);

    const { verifier, challenge } = pkcePair();
    const { code } = await authorizeAndGetCode(db.auth, {
      clientId: client_id, scope: "env:live openid", cookie: miaCookie, challenge,
    });
    expect(code).toBeTruthy();
    const scope = await exchangeCodeForScope(client_id, client_secret, code!, verifier);
    expect(scope).not.toContain("env:live");
  });
});

describe("rule 2: env:live requires an approved, unexpired live grant", () => {
  it("live-allowed client + user with NO approved live grant → env:live silently dropped", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Live Allowed Client" },
      asResponse: true,
    } as any);
    const { client_id, client_secret } = await reg.json();
    const app = getAppPool();
    await upsertClientPolicy(app, client_id, "Live Allowed Client", ["env:dev", "env:live"]);
    // mia has no approved live grant in the seed data used by setupWebDb's personas.

    const { verifier, challenge } = pkcePair();
    const { code } = await authorizeAndGetCode(db.auth, {
      clientId: client_id, scope: "env:live openid", cookie: miaCookie, challenge,
    });
    expect(code).toBeTruthy();
    const scope = await exchangeCodeForScope(client_id, client_secret, code!, verifier);
    expect(scope).not.toContain("env:live");
  });

  it("live-allowed client + user WITH an approved, unexpired live grant → env:live survives", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Live Allowed Client 2" },
      asResponse: true,
    } as any);
    const { client_id, client_secret } = await reg.json();
    const app = getAppPool();
    await upsertClientPolicy(app, client_id, "Live Allowed Client 2", ["env:dev", "env:live"]);
    const grantId = await requestGrant(app, {
      userId: "mia", collection: "people", env: "live",
      purposeLabel: "test", allowedFields: ["id"],
    });
    await approveGrant(app, grantId, "marcus", { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });

    const { verifier, challenge } = pkcePair();
    const { code } = await authorizeAndGetCode(db.auth, {
      clientId: client_id, scope: "env:live", cookie: miaCookie, challenge,
    });
    expect(code).toBeTruthy();
    const scope = await exchangeCodeForScope(client_id, client_secret, code!, verifier);
    expect(scope).toContain("env:live");
  });
});
