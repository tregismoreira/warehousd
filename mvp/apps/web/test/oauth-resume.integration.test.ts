import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb } from "./helpers/web-db";
import { pkcePair } from "./helpers/oauth";
import { upsertClientPolicy, approveGrant, requestGrant } from "@warehousd/broker";
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

// Extracts all Set-Cookie headers from a response and formats them as a Cookie header.
function extractCookies(res: Response): string {
  const setCookieHeaders = res.headers.getSetCookie?.() ?? [];
  return setCookieHeaders
    .map((c: string) => c.split(";")[0].trim())
    .join("; ");
}

describe("env-scope behavior via authorize-resume (no cookie → sign-in → callback)", () => {
  it("case 1: dev-only client requesting env:live via resume gets only env:dev (regression/hardening check)", async () => {
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

    // GET /mcp/authorize with NO cookie → 302 to /login with oidc_login_prompt.
    const authorizeRes = await db.auth.handler(
      new Request(authorizeUrl, { method: "GET" })
    );
    expect(authorizeRes.status).toBe(302);
    const authorizeLocation = authorizeRes.headers.get("location");
    expect(authorizeLocation).toContain("/login");

    // Extract the oidc_login_prompt cookie (and others if present).
    const authorizeCookies = extractCookies(authorizeRes);
    expect(authorizeCookies).toContain("oidc_login_prompt");

    // POST /sign-in/email with oidc_login_prompt cookie → 302 to callback?code=...
    const signInRes = await db.auth.handler(
      new Request("http://localhost:8722/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: authorizeCookies,
        },
        body: JSON.stringify({ email: "mia@meridian.demo", password: "demo" }),
      })
    );
    expect(signInRes.status).toBe(302);
    const signInLocation = signInRes.headers.get("location");
    expect(signInLocation).toContain("http://localhost:9999/callback");

    // Extract the code from the callback redirect.
    const callbackUrl = new URL(signInLocation ?? "", "http://localhost");
    const code = callbackUrl.searchParams.get("code");
    expect(code).toBeTruthy();

    // Exchange the code for a token and inspect the scope.
    const scope = await exchangeCodeForScope(client_id, client_secret, code!, verifier);
    // Rule 1 enforcement: dev-only client should never get env:live, even via resume.
    // This passes today (envScopePlugin's before-hook runs on the authorize request before the session exists,
    // conservatively stripping env:live and freezing that safe scope into oidc_login_prompt).
    expect(scope).not.toContain("env:live");
  });

  it("case 2: eligible live-grant user via resume path should redirect to env-picker but silently downgrades to env:dev (BUG)", async () => {
    // Register a client with both env:dev and env:live allowed.
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Both Envs Resume Client" },
      asResponse: true,
    } as any);
    const { client_id, client_secret } = await reg.json();
    const app = getAppPool();
    await upsertClientPolicy(app, client_id, "Both Envs Resume Client", ["env:dev", "env:live"]);

    // Give mia an approved, unexpired live grant (same pattern as oauth-scope.integration.test.ts).
    const grantId = await requestGrant(app, {
      userId: "mia", collection: "people", env: "live",
      purposeLabel: "resume-test", allowedFields: ["id"],
    });
    await approveGrant(app, grantId, "marcus", { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });

    const { verifier, challenge } = pkcePair();
    const authorizeUrl = new URL("http://localhost:8722/api/auth/mcp/authorize");
    authorizeUrl.searchParams.set("client_id", client_id);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", "http://localhost:9999/callback");
    authorizeUrl.searchParams.set("scope", "env:dev env:live openid");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    // GET /mcp/authorize with NO cookie → 302 to /login with oidc_login_prompt.
    const authorizeRes = await db.auth.handler(
      new Request(authorizeUrl, { method: "GET" })
    );
    expect(authorizeRes.status).toBe(302);
    const authorizeLocation = authorizeRes.headers.get("location");
    expect(authorizeLocation).toContain("/login");

    // Extract the oidc_login_prompt cookie.
    const authorizeCookies = extractCookies(authorizeRes);
    expect(authorizeCookies).toContain("oidc_login_prompt");

    // POST /sign-in/email with oidc_login_prompt cookie.
    // Per SPECS §6.1 rule 3, when both env:dev and env:live survive eligibility checks
    // (eligible user + live-allowed client), the user should be redirected to /oauth/env-picker
    // to choose which env to use. However, the resume path currently skips this redirect and
    // silently returns a 302 to callback?code=... with env:dev-only scope instead.
    const signInRes = await db.auth.handler(
      new Request("http://localhost:8722/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: authorizeCookies,
        },
        body: JSON.stringify({ email: "mia@meridian.demo", password: "demo" }),
      })
    );

    // This assertion FAILS: signInRes is a 302 to callback?code=..., not a 3xx to /oauth/env-picker.
    // The bug: the resume path silently downgrades an eligible user to env:dev instead of showing the picker.
    expect(signInRes.status).toBeGreaterThanOrEqual(300);
    expect(signInRes.status).toBeLessThan(400);
    expect(signInRes.headers.get("location")).toContain("/oauth/env-picker");
  });
});
