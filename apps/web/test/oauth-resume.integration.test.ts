import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { pkcePair } from "./helpers/oauth";
import { upsertClientPolicy } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;

beforeAll(async () => {
  db = await setupWebDb("oauthresume");
}, 60_000);
afterAll(async () => { await db?.end(); });

// Exchanges an authorization code for a token, returning the granted scope.
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

describe("env-scope redirect-to-login before cookie-resume can arm", () => {
  it("case 1: dev-only client requesting env:live gets dev-only scope after redirect-login flow", async () => {
    // Register a client with default policy {env:dev, env:live}.
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Dev Only Resume Client" },
      asResponse: true,
    } as any);
    const { client_id, client_secret } = await reg.json();

    // Force the policy to dev-only.
    const app = getAppPool();
    await upsertClientPolicy(app, client_id, "Dev Only Resume Client", ["env:dev"]);

    const { verifier, challenge } = pkcePair();
    const authorizeUrl = new URL("http://localhost:8722/api/auth/mcp/authorize");
    authorizeUrl.searchParams.set("client_id", client_id);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", "http://localhost:9999/callback");
    authorizeUrl.searchParams.set("scope", "env:live openid");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    // Step 1: GET /mcp/authorize with NO cookie → 302 to /login with original query string intact.
    const authorizeRes = await db.auth.handler(
      new Request(authorizeUrl, { method: "GET" })
    );
    expect(authorizeRes.status).toBe(302);
    const authorizeLocation = authorizeRes.headers.get("location");
    expect(authorizeLocation).toContain("/login");
    // Verify original query params are preserved.
    expect(authorizeLocation).toContain("client_id=" + client_id);
    expect(authorizeLocation).toContain("scope=env%3Alive");

    // Step 2: POST /sign-in/email normally (no special cookie forwarding).
    const sessionCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
    expect(sessionCookie).toBeTruthy();

    // Step 3: GET /mcp/authorize AGAIN, same original query params, WITH the session cookie.
    const authorizeRes2 = await db.auth.handler(
      new Request(authorizeUrl, {
        method: "GET",
        headers: {
          cookie: sessionCookie,
        },
      })
    );
    // This second response should be the final authorize call, resulting in a 302 callback redirect.
    expect(authorizeRes2.status).toBe(302);
    const callbackLocation = authorizeRes2.headers.get("location");
    expect(callbackLocation).toContain("http://localhost:9999/callback");

    // Step 4: Extract the code and exchange for token to verify the granted scope.
    const callbackUrl = new URL(callbackLocation ?? "", "http://localhost");
    const code = callbackUrl.searchParams.get("code");
    expect(code).toBeTruthy();

    const scope = await exchangeCodeForScope(client_id, client_secret, code!, verifier);
    // Case 1 assertion: dev-only client should NOT have env:live in final scope.
    expect(scope).not.toContain("env:live");
    expect(scope).toContain("env:dev");
  });

  it("case 2: live-allowed client with eligible user gets env-picker redirect on second request", async () => {
    // Register a client with default policy {env:dev, env:live}.
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Live Allowed Resume Client" },
      asResponse: true,
    } as any);
    const { client_id, client_secret } = await reg.json();
    // Keep the default policy (both env:dev and env:live allowed).

    // Grant mia an approved live grant so she becomes eligible.
    const app = getAppPool();
    await app.query(
      `insert into app.grants (user_id, collection, allowed_fields, env, status, expires_at) values
       ($1, 'people', array['id'], 'live', 'approved', now() + interval '1 day')`,
      ["mia"]
    );

    const { verifier, challenge } = pkcePair();
    const authorizeUrl = new URL("http://localhost:8722/api/auth/mcp/authorize");
    authorizeUrl.searchParams.set("client_id", client_id);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", "http://localhost:9999/callback");
    // Request BOTH env:dev and env:live to trigger the env-picker rule.
    authorizeUrl.searchParams.set("scope", "env:dev env:live openid");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    // Step 1: GET /mcp/authorize with NO cookie → 302 to /login with original query string intact.
    const authorizeRes = await db.auth.handler(
      new Request(authorizeUrl, { method: "GET" })
    );
    expect(authorizeRes.status).toBe(302);
    const authorizeLocation = authorizeRes.headers.get("location");
    expect(authorizeLocation).toContain("/login");
    // Verify original query params are preserved.
    expect(authorizeLocation).toContain("client_id=" + client_id);
    expect(authorizeLocation).toContain("env%3Adev");
    expect(authorizeLocation).toContain("env%3Alive");

    // Step 2: POST /sign-in/email normally (no special cookie forwarding).
    const sessionCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
    expect(sessionCookie).toBeTruthy();

    // Step 3: GET /mcp/authorize AGAIN, same original query params, WITH the session cookie.
    const authorizeRes2 = await db.auth.handler(
      new Request(authorizeUrl, {
        method: "GET",
        headers: {
          cookie: sessionCookie,
        },
      })
    );
    // Case 2: This second request should redirect to /oauth/env-picker because:
    // - Client policy allows both env:dev and env:live
    // - User is eligible for env:live (has approved, unexpired grant)
    // - Requested scope has both env:dev and env:live
    // - Rule 1: both are in policy and requested, survivors = [env:dev, env:live]
    // - Rule 2: user is eligible, so env:live is not filtered out
    // - Both survive, so env-picker is triggered
    expect(authorizeRes2.status).toBe(302);
    const pickerLocation = authorizeRes2.headers.get("location");
    expect(pickerLocation).toContain("/oauth/env-picker");
    // Verify original query params are preserved in the picker redirect.
    expect(pickerLocation).toContain("client_id=" + client_id);
    expect(pickerLocation).toContain("env%3Adev");
    expect(pickerLocation).toContain("env%3Alive");
  });

  it("case 3: live-allowed client with no approved live grant gets dev-only scope after redirect-login flow", async () => {
    // Register a client with default policy {env:dev, env:live}.
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "No Grant Resume Client" },
      asResponse: true,
    } as any);
    const { client_id, client_secret } = await reg.json();
    // Keep the default policy (both env:dev and env:live allowed).
    // marcus has no approved live grant, unlike mia in case 2.

    const { verifier, challenge } = pkcePair();
    const authorizeUrl = new URL("http://localhost:8722/api/auth/mcp/authorize");
    authorizeUrl.searchParams.set("client_id", client_id);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", "http://localhost:9999/callback");
    // Request BOTH env:dev and env:live; rule 2 should filter env:live since marcus is ineligible.
    authorizeUrl.searchParams.set("scope", "env:dev env:live openid");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    // Step 1: GET /mcp/authorize with NO cookie → 302 to /login with original query string intact.
    const authorizeRes = await db.auth.handler(
      new Request(authorizeUrl, { method: "GET" })
    );
    expect(authorizeRes.status).toBe(302);
    const authorizeLocation = authorizeRes.headers.get("location");
    expect(authorizeLocation).toContain("/login");
    expect(authorizeLocation).toContain("client_id=" + client_id);

    // Step 2: POST /sign-in/email normally (no special cookie forwarding).
    const sessionCookie = await signIn(db.auth, "marcus@meridian.demo", "demo");
    expect(sessionCookie).toBeTruthy();

    // Step 3: GET /mcp/authorize AGAIN, same original query params, WITH the session cookie.
    const authorizeRes2 = await db.auth.handler(
      new Request(authorizeUrl, {
        method: "GET",
        headers: {
          cookie: sessionCookie,
        },
      })
    );
    // Rule 1: both env:dev and env:live are in policy and requested, survivors = [env:dev, env:live].
    // Rule 2: marcus has no approved live grant, so env:live is filtered out, survivors = [env:dev].
    // Only one survivor, so no env-picker; this resolves directly to the callback redirect.
    expect(authorizeRes2.status).toBe(302);
    const callbackLocation = authorizeRes2.headers.get("location");
    expect(callbackLocation).toContain("http://localhost:9999/callback");

    // Step 4: Extract the code and exchange for token to verify the granted scope.
    const callbackUrl = new URL(callbackLocation ?? "", "http://localhost");
    const code = callbackUrl.searchParams.get("code");
    expect(code).toBeTruthy();

    const scope = await exchangeCodeForScope(client_id, client_secret, code!, verifier);
    expect(scope).toContain("env:dev");
    expect(scope).not.toContain("env:live");
  });
});
