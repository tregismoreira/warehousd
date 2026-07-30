import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { setupWebDb, signIn } from "./helpers/web-db";
import { authorizeAndGetCode, pkcePair } from "./helpers/oauth";
import { cookiePair } from "./helpers/cookies";
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
  anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");

  // Register the Keycloak OIDC provider (requires admin role)
  const registerOidcRes = await db.auth.handler(
    new Request("http://localhost:8722/api/auth/sso/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: anaCookie,
      },
      body: JSON.stringify({
        providerId: "keycloak-oidc",
        issuer: REALM_ENDPOINT,
        domain: "harbor.demo",
        oidcConfig: {
          clientId: "warehousd-oidc",
          clientSecret: "oidc-secret",
          discoveryEndpoint: `${REALM_ENDPOINT}/.well-known/openid-configuration`,
        },
      }),
    }),
  );

  if (!registerOidcRes.ok) {
    throw new Error(`Failed to register OIDC SSO provider: ${registerOidcRes.status}`);
  }

  // Fetch SAML certificate for provider registration
  const samlCert = await getSamlCertificate();

  // Register the Keycloak SAML provider (requires admin role)
  const registerSamlRes = await db.auth.handler(
    new Request("http://localhost:8722/api/auth/sso/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: anaCookie,
      },
      body: JSON.stringify({
        providerId: "keycloak-saml",
        issuer: REALM_ENDPOINT,
        domain: "harbor.demo",
        samlConfig: {
          entryPoint: `${REALM_ENDPOINT}/protocol/saml`,
          cert: samlCert,
          callbackUrl: "http://localhost:8722/api/auth/sso/saml2/sp/acs/keycloak-saml",
          spMetadata: {
            entityID: "warehousd-sp",
          },
          authnRequestsSigned: false,
          wantAssertionsSigned: true,
          mapping: {
            id: "email",
            email: "email",
            name: "given name",
            lastName: "family name",
          },
        },
      }),
    }),
  );

  if (!registerSamlRes.ok) {
    throw new Error(`Failed to register SAML SSO provider: ${registerSamlRes.status}`);
  }
}, 120_000);

afterAll(async () => {
  await db?.end();
});

async function waitForKeycloak(maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${REALM_ENDPOINT}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(5000),
      });
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
  // Extract the form tag (order-independent by matching <form...> first)
  const formTagMatch = html.match(/<form[^>]*>([\s\S]*?)<\/form>/i);
  if (!formTagMatch) {
    throw new Error("Could not find login form in HTML");
  }

  const formTag = formTagMatch[0];
  const formBody = formTagMatch[1] ?? "";

  // Extract action attribute independently of other attributes
  const actionMatch = formTag.match(/action="([^"]*)"/i);
  if (!actionMatch || !actionMatch[1]) {
    throw new Error("Login form action URL is missing or empty");
  }
  const action = actionMatch[1];

  // Extract input fields independently of attribute order
  const fields: Record<string, string> = {};
  const inputMatches = formBody.matchAll(/<input[^>]*>/g);
  for (const inputMatch of inputMatches) {
    const inputTag = inputMatch[0];
    const nameMatch = inputTag.match(/name="([^"]*)"/i);
    const valueMatch = inputTag.match(/value="([^"]*)"/i);
    const name = nameMatch?.[1];
    const value = valueMatch?.[1];
    if (name !== undefined && value !== undefined) {
      fields[name] = value;
    }
  }

  return { action, fields };
}

// Helper: Fetch SAML metadata and extract the X.509 certificate
async function getSamlCertificate(): Promise<string> {
  const descriptorUrl = `${REALM_ENDPOINT}/protocol/saml/descriptor`;
  const res = await fetch(descriptorUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch SAML descriptor: ${res.status}`);
  }
  const xml = await res.text();

  // Extract X.509 certificate from <ds:X509Certificate> tag, handling multi-line content
  const certMatch = xml.match(/<ds:X509Certificate>([\s\S]+?)<\/ds:X509Certificate>/);
  if (!certMatch || !certMatch[1]) {
    throw new Error("Could not extract X.509 certificate from SAML descriptor");
  }

  return certMatch[1].trim();
}

// Helper: Parse SAML form response and extract SAMLResponse and RelayState
function parseSamlForm(html: string): { samlResponse: string; relayState: string } {
  const samlResponseMatch = html.match(/name="SAMLResponse"\s+value="([^"]*)"/i);
  const relayStateMatch = html.match(/name="RelayState"\s+value="([^"]*)"/i);

  if (!samlResponseMatch || !samlResponseMatch[1]) {
    throw new Error("Could not find SAMLResponse in form");
  }
  if (!relayStateMatch || !relayStateMatch[1]) {
    throw new Error("Could not find RelayState in form");
  }

  return {
    samlResponse: samlResponseMatch[1],
    relayState: relayStateMatch[1],
  };
}

describe.skipIf(!process.env.WAREHOUSD_E2E_KEYCLOAK)(
  "SSO: Real Keycloak OIDC and SAML providers",
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
      const stateCookie = cookiePair(setCookieHeader);

      // Step 2: Fetch the authorization URL (real HTTP to Keycloak)
      const authRes = await fetch(authorizationUrl, { redirect: "manual" });

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
      const cookiePairs = loginCookies.map(cookiePair).join("; ");
      const allCookies = cookiePairs + "; " + stateCookie;

      // Step 4: POST credentials to login form
      const loginFormUrl = new URL(action, KEYCLOAK_BASE);
      const formData = new URLSearchParams();
      formData.append("username", "sso-user@harbor.demo");
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

      // Extract session cookie from callback response using proper Set-Cookie parsing
      const sessionCookie = callbackRes.headers.getSetCookie().map(cookiePair).join("; ");

      // Step 6: Verify user was created with role='member'
      const userResult = await appPool.query(
        `select id, email, role from app."user" where email = $1`,
        ["sso-user@harbor.demo"],
      );

      expect(userResult.rows).toHaveLength(1);
      const user = userResult.rows[0];
      expect(user.email).toBe("sso-user@harbor.demo");
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
      await upsertClientPolicy(appPool, client_id, "Keycloak Test Client", ["env:dev"]);

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

    it("SAML: signs in via Keycloak's SAML flow, creates user with role='member', and completes OAuth flow", async () => {
      // Step 1: POST /sign-in/sso to get authorization URL and state cookie (SAML flow)
      const signInUrl = new URL("http://localhost:8722/api/auth/sign-in/sso");
      const signInRes = await db.auth.handler(
        new Request(signInUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            providerId: "keycloak-saml",
            callbackURL: "/",
          }),
        }),
      );

      const signInBody = (await signInRes.json()) as { url: string };
      const authorizationUrl = signInBody.url;

      // Extract state cookie from Set-Cookie header
      const setCookieHeader = signInRes.headers.get("set-cookie") ?? "";
      const stateCookie = cookiePair(setCookieHeader);

      // Step 2: Fetch the authorization URL (may return HTML directly or redirect to Keycloak)
      const authRes = await fetch(authorizationUrl, { redirect: "manual" });

      // Handle both direct HTML (200) and redirect (300+) responses
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

      // Extract cookies from login page response
      const loginCookies = loginRes.headers.getSetCookie();
      const cookiePairs = loginCookies.map(cookiePair).join("; ");
      const allCookies = cookiePairs + "; " + stateCookie;

      // Step 4: POST credentials to login form (use a different user for SAML vs OIDC)
      const loginFormUrl = new URL(action, KEYCLOAK_BASE);
      const formData = new URLSearchParams();
      formData.append("username", "sso-saml-user@harbor.demo");
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

      // Keycloak should return HTML with auto-submit form containing SAMLResponse and RelayState
      expect(loginPostRes.status).toBe(200);
      const samlResponseHtml = await loginPostRes.text();

      // Parse SAMLResponse and RelayState from the form
      const { samlResponse, relayState } = parseSamlForm(samlResponseHtml);

      // Step 5: POST SAMLResponse and RelayState to the SAML ACS endpoint
      const acsFormData = new URLSearchParams();
      acsFormData.append("SAMLResponse", samlResponse);
      acsFormData.append("RelayState", relayState);

      const acsRes = await db.auth.handler(
        new Request("http://localhost:8722/api/auth/sso/saml2/sp/acs/keycloak-saml", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: stateCookie,
          },
          body: acsFormData.toString(),
        }),
      );

      // Extract session cookie from ACS response using proper Set-Cookie parsing
      // (ACS endpoint may redirect with session cookie or set it directly)
      let sessionCookie = acsRes.headers.getSetCookie().map(cookiePair).join("; ");

      // If ACS returns a redirect (e.g., to RelayState/callback), follow it
      if (acsRes.status >= 300 && acsRes.status < 400) {
        let redirectUrl = acsRes.headers.get("location");
        if (redirectUrl) {
          // Make absolute URL if relative
          if (!redirectUrl.startsWith("http")) {
            redirectUrl =
              "http://localhost:8722" + (redirectUrl.startsWith("/") ? "" : "/") + redirectUrl;
          }
          const redirectRes = await db.auth.handler(
            new Request(redirectUrl, {
              headers: { cookie: stateCookie },
            }),
          );
          const redirectCookies = redirectRes.headers.getSetCookie().map(cookiePair);
          if (redirectCookies.length > 0) {
            sessionCookie = redirectCookies.join("; ");
          }
        }
      }

      if (!sessionCookie || sessionCookie.trim() === "") {
        throw new Error(`No session cookie from SAML flow. ACS status: ${acsRes.status}`);
      }

      // Step 6: Verify user was created with role='member'
      const userResult = await appPool.query(
        `select id, email, role from app."user" where email = $1`,
        ["sso-saml-user@harbor.demo"],
      );

      if (userResult.rows.length === 0) {
        throw new Error(
          `User not created after SAML login. ACS status: ${acsRes.status}, sessionCookie: "${sessionCookie}"`,
        );
      }

      expect(userResult.rows).toHaveLength(1);
      const user = userResult.rows[0];
      expect(user.email).toBe("sso-saml-user@harbor.demo");
      expect(user.role).toBe("member");

      // Step 7: Test that SAML login can resume MCP authorize flow identically to OIDC
      const reg = await db.auth.api.registerMcpClient({
        body: {
          redirect_uris: ["http://localhost:9999/callback"],
          client_name: "Keycloak SAML Test Client",
        },
        asResponse: true,
      } as any);
      const { client_id, client_secret } = await reg.json();
      await upsertClientPolicy(appPool, client_id, "Keycloak SAML Test Client", ["env:dev"]);

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

      expect(grantedScope).toContain("env:dev");
    });

    it("SAML: SP metadata endpoint responds with XML containing the SP entity ID", async () => {
      const metadataRes = await db.auth.handler(
        new Request(
          "http://localhost:8722/api/auth/sso/saml2/sp/metadata?providerId=keycloak-saml",
        ),
      );

      expect(metadataRes.status).toBe(200);
      const metadataXml = await metadataRes.text();
      expect(metadataXml).toContain("warehousd-sp");
    });
  },
);
