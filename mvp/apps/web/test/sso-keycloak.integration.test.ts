import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { setupWebDb, signIn } from "./helpers/web-db";
import { authorizeAndGetCode, pkcePair } from "./helpers/oauth";
import { upsertClientPolicy } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

const KEYCLOAK_PORT = 8780;
const KEYCLOAK_BASE = `http://127.0.0.1:${KEYCLOAK_PORT}`;
const KEYCLOAK_REALM = "warehousd-test";
const REALM_ENDPOINT = `${KEYCLOAK_BASE}/realms/${KEYCLOAK_REALM}`;

let db: Awaited<ReturnType<typeof setupWebDb>>;
let appPool: Pool;
let anaCookie: string;

beforeAll(async () => {
  // Poll Keycloak's discovery document until it's ready (more reliable than docker healthcheck)
  await waitForKeycloak();

  db = await setupWebDb("keycloak");
  appPool = getAppPool();

  // Sign in as admin to register SSO provider
  anaCookie = await signIn(db.auth, "ana@meridian.demo", "demo");

  // Register the Keycloak OIDC provider (requires admin role)
  const registerRes = await db.auth.handler(
    new Request("http://localhost:8722/api/auth/sso/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: anaCookie,
      },
      body: JSON.stringify({
        providerId: "keycloak-oidc",
        issuer: REALM_ENDPOINT,
        domain: "meridian.demo",
        oidcConfig: {
          clientId: "warehousd-oidc",
          clientSecret: "oidc-secret",
          discoveryEndpoint: `${REALM_ENDPOINT}/.well-known/openid-configuration`,
        },
      }),
    }),
  );

  if (!registerRes.ok) {
    throw new Error(`Failed to register SSO provider: ${registerRes.status}`);
  }
}, 120_000);

afterAll(async () => {
  await db?.end();
});

async function waitForKeycloak(maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(
        `${REALM_ENDPOINT}/.well-known/openid-configuration`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (res.ok) {
        return;
      }
    } catch (_e) {
      // Connection failed or timeout, retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Keycloak did not become ready in time");
}

// Helper: Parse HTML form from login page and extract action URL and input fields
function parseLoginForm(html: string): { action: string; fields: Record<string, string> } {
  const formMatch = html.match(
    /<form[^>]*action="([^"]*)"[^>]*method="post"[^>]*>([\s\S]*?)<\/form>/i,
  );
  if (!formMatch) {
    throw new Error("Could not find login form in HTML");
  }
  const action = formMatch[1];
  const formBody = formMatch[2];

  const fields: Record<string, string> = {};
  const inputMatches = formBody.matchAll(/<input[^>]*name="([^"]*)"[^>]*value="([^"]*)"[^>]*>/g);
  for (const match of inputMatches) {
    fields[match[1]] = match[2];
  }

  return { action, fields };
}

describe.skipIf(!process.env.WAREHOUSD_E2E_KEYCLOAK)(
  "SSO: Real Keycloak OIDC provider",
  () => {
    it("signs in via Keycloak's login form, creates user with role='member', and completes OAuth flow", async () => {
      // Step 1: POST /sign-in/sso to get authorization URL and state cookie
      const signInUrl = new URL("http://localhost:8722/api/auth/sign-in/sso");
      const signInRes = await db.auth.handler(
        new Request(signInUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            providerId: "keycloak-oidc",
            callbackURL: "/",
          }),
        }),
      );

      const signInBody = (await signInRes.json()) as { url: string };
      const authorizationUrl = signInBody.url;

      // Extract state cookie from Set-Cookie header
      const setCookieHeader = signInRes.headers.get("set-cookie") ?? "";
      const stateCookie = setCookieHeader.split(";")[0].trim();

      // Step 2: Fetch the authorization URL (real HTTP to Keycloak)
      const authRes = await fetch(authorizationUrl, { redirect: "manual" });
      const authText = await authRes.text();

      // If we got HTML (200), this is the login page; if we got redirect (300+), follow it
      let loginPageUrl: string;
      if (authRes.status === 200) {
        loginPageUrl = authorizationUrl;
      } else {
        expect(authRes.status).toBeGreaterThanOrEqual(300);
        expect(authRes.status).toBeLessThan(400);
        loginPageUrl = authRes.headers.get("location") ?? "";
        expect(loginPageUrl).toContain(KEYCLOAK_BASE);
      }

      // Step 3: Fetch the login page and parse the form
      const loginRes = await fetch(loginPageUrl);
      const loginHtml = await loginRes.text();
      const { action, fields } = parseLoginForm(loginHtml);

      // Extract cookies from login page response (may include AUTH_SESSION_ID, KC_RESTART)
      const loginCookies = loginRes.headers.getSetCookie();
      const cookiePairs = loginCookies.map((cookie) => cookie.split(";")[0].trim()).join("; ");
      const allCookies = cookiePairs + "; " + stateCookie;

      // Step 4: POST credentials to login form
      const loginFormUrl = new URL(action, KEYCLOAK_BASE);
      const formData = new URLSearchParams();
      formData.append("username", "sso-user@meridian.demo");
      formData.append("password", "demo");
      for (const [key, value] of Object.entries(fields)) {
        formData.append(key, value);
      }

      const loginPostRes = await fetch(loginFormUrl, {
        method: "POST",
        body: formData,
        headers: { cookie: allCookies },
        redirect: "manual",
      });

      expect(loginPostRes.status).toBeGreaterThanOrEqual(300);
      expect(loginPostRes.status).toBeLessThan(400);

      const callbackUrl = loginPostRes.headers.get("location") ?? "";
      expect(callbackUrl).toContain("/api/auth/sso/callback/keycloak-oidc");

      // Step 5: Follow the callback to Better Auth's /sso/callback/:providerId
      const callbackRes = await db.auth.handler(
        new Request(callbackUrl, {
          headers: { cookie: stateCookie },
        }),
      );

      // Extract session cookie from callback response
      const callbackSetCookie = callbackRes.headers.get("set-cookie") ?? "";
      const sessionCookie = callbackSetCookie
        .split(/,(?=[^;]+?=)/)
        .map((c: string) => c.split(";")[0].trim())
        .join("; ");

      // Step 6: Verify user was created with role='member'
      const userResult = await appPool.query(
        `select id, email, role from app."user" where email = $1`,
        ["sso-user@meridian.demo"],
      );

      expect(userResult.rows).toHaveLength(1);
      const user = userResult.rows[0];
      expect(user.email).toBe("sso-user@meridian.demo");
      expect(user.role).toBe("member");

      // Step 7: Test full OAuth flow: /mcp/authorize → code → token with proper scope
      const reg = await db.auth.api.registerMcpClient({
        body: {
          redirect_uris: ["http://localhost:9999/callback"],
          client_name: "Keycloak Test Client",
        },
        asResponse: true,
      } as any);
      const { client_id, client_secret } = await reg.json();
      await upsertClientPolicy(appPool, client_id, "Keycloak Test Client", [
        "env:dev",
      ]);

      const { verifier, challenge } = pkcePair();
      const { code } = await authorizeAndGetCode(db.auth, {
        clientId: client_id,
        scope: "env:dev openid",
        cookie: sessionCookie,
        challenge,
      });

      expect(code).toBeTruthy();

      // Exchange code for token and verify scope
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
      const tokenBody = await tokenRes.json();
      const grantedScope = tokenBody.scope as string;

      // env:dev should be present, env:live only if granted
      expect(grantedScope).toContain("env:dev");
    });
  },
);
