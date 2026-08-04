import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { setupWebDb, signIn } from "./helpers/web-db";
import { ssoSignIn } from "./helpers/sso";
import { startFakeIdp } from "./helpers/fake-idp";
import { pkcePair } from "./helpers/oauth";
import { upsertClientPolicy, approveGrant, requestGrant, loadConfig } from "@warehousd/broker";

// approveGrant validates verbs against the collection's config, and these fixtures grant over
// harbor collections — so that is the config the rules have to be checked against.
const harborCfg = loadConfig(new URL("../../../examples/harbor", import.meta.url).pathname);

import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let fakeIdp: Awaited<ReturnType<typeof startFakeIdp>>;
let appPool: Pool;
let anaCookie: string;

beforeAll(async () => {
  fakeIdp = await startFakeIdp({ users: [] });
  db = await setupWebDb("sso-oidc");
  appPool = getAppPool();

  // Sign in as admin to register SSO provider
  anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");

  // Register the fake OIDC provider (requires admin role)
  const registerRes = await db.auth.handler(
    new Request("http://localhost:8722/api/auth/sso/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: anaCookie,
      },
      body: JSON.stringify({
        providerId: "test-oidc",
        issuer: fakeIdp.issuer,
        domain: "harbor.demo",
        oidcConfig: {
          clientId: "test-client",
          clientSecret: "test-secret",
          discoveryEndpoint: `${fakeIdp.issuer}/.well-known/openid-configuration`,
        },
      }),
    }),
  );

  if (!registerRes.ok) {
    throw new Error(`Failed to register SSO provider: ${registerRes.status}`);
  }
}, 60_000);

afterAll(async () => {
  await db?.end();
  await fakeIdp?.close();
});

describe("SSO: JIT provisioning", () => {
  it("signs in a new SSO identity and creates a user with role='member'", async () => {
    fakeIdp.setNextUser({
      sub: "newperson@harbor.demo",
      email: "newperson@harbor.demo",
      email_verified: true,
      name: "New Person",
    });

    await ssoSignIn(db.auth, "test-oidc", "/");

    // Query the database for the new user
    const result = await appPool.query(`select id, email, role from app."user" where email = $1`, [
      "newperson@harbor.demo",
    ]);

    expect(result.rows).toHaveLength(1);
    const user = result.rows[0];
    expect(user.email).toBe("newperson@harbor.demo");
    expect(user.role).toBe("member");
  });
});

describe("SSO: No demotion on link", () => {
  it("an existing admin who links an SSO account stays admin", async () => {
    fakeIdp.setNextUser({
      sub: "ana@harbor.demo",
      email: "ana@harbor.demo",
      email_verified: true,
      name: "Ana",
    });

    await ssoSignIn(db.auth, "test-oidc", "/");

    // Check ana's role
    const result = await appPool.query(`select role from app."user" where email = $1`, [
      "ana@harbor.demo",
    ]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].role).toBe("admin");
  });
});

describe("SSO: MCP authorize delegates to the IdP", () => {
  it("redirects to /login when not authenticated, then via SSO returns a code", async () => {
    // Register an OAuth client first
    const reg = await db.auth.api.registerMcpClient({
      body: {
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "MCP Delegate Test Client",
      },
      asResponse: true,
    } as any);
    const { client_id, client_secret } = await reg.json();

    // Step 1: GET /api/auth/mcp/authorize without cookie should redirect to /login
    const { verifier, challenge } = pkcePair();
    const authorizeUrl = new URL("http://localhost:8722/api/auth/mcp/authorize");
    authorizeUrl.searchParams.set("client_id", client_id);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", "http://localhost:9999/callback");
    authorizeUrl.searchParams.set("scope", "env:dev openid");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const noAuthRes = await db.auth.handler(new Request(authorizeUrl, { redirect: "manual" }));

    expect(noAuthRes.status).toBeGreaterThanOrEqual(300);
    expect(noAuthRes.status).toBeLessThan(400);
    const redirectLocation = noAuthRes.headers.get("location") ?? "";
    expect(redirectLocation).toContain("/login");
    expect(redirectLocation).toContain(`client_id=${client_id}`);

    // Step 2: Sign in via SSO to establish a session
    fakeIdp.setNextUser({
      sub: "scenario3ssouser@harbor.demo",
      email: "scenario3ssouser@harbor.demo",
      email_verified: true,
      name: "Scenario 3 SSO User",
    });

    const { cookie: sessionCookie } = await ssoSignIn(db.auth, "test-oidc", "/");

    // Step 3: Now call mcp/authorize with the SSO session
    const mcpRes = await db.auth.handler(
      new Request(authorizeUrl, { headers: { cookie: sessionCookie } }),
    );

    const location = mcpRes.headers.get("location") ?? "";
    // Should redirect to the callback with a code (no env picker for single env)
    expect(location).toContain("http://localhost:9999/callback");
    expect(location).toContain("code=");

    // Extract and verify the code
    const code = new URL(location, "http://localhost").searchParams.get("code");
    expect(code).toBeTruthy();

    // Exchange the code for a token and verify the scope
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
    const body = await tokenRes.json();
    const grantedScope = body.scope as string;
    expect(grantedScope).toContain("env:dev");
  });
});

describe("SSO: Rules 1-3 hold on the SSO path", () => {
  it("rule 1: dev-only client requesting env:live gets only env:dev", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: {
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "SSO Dev Only Client",
      },
      asResponse: true,
    } as any);
    const { client_id, client_secret } = await reg.json();
    await upsertClientPolicy(appPool, client_id, "SSO Dev Only Client", ["env:dev"]);

    // Sign in via SSO to establish session (use fresh SSO-only user)
    fakeIdp.setNextUser({
      sub: "rule1ssouser@harbor.demo",
      email: "rule1ssouser@harbor.demo",
      email_verified: true,
      name: "Rule 1 SSO User",
    });
    const { cookie: sessionCookie } = await ssoSignIn(db.auth, "test-oidc", "/");

    const { verifier, challenge } = pkcePair();
    const authorizeUrl = new URL("http://localhost:8722/api/auth/mcp/authorize");
    authorizeUrl.searchParams.set("client_id", client_id);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", "http://localhost:9999/callback");
    authorizeUrl.searchParams.set("scope", "env:live openid");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const res = await db.auth.handler(
      new Request(authorizeUrl, { headers: { cookie: sessionCookie } }),
    );

    const location = res.headers.get("location") ?? "";
    const code = new URL(location, "http://localhost").searchParams.get("code");
    expect(code).toBeTruthy();

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
    const body = await tokenRes.json();
    const scope = body.scope as string;

    expect(scope).not.toContain("env:live");
    expect(scope).toContain("env:dev");
  });

  it("rule 2: env:live requires an approved, unexpired live grant", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: {
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "SSO Live Allowed Client",
      },
      asResponse: true,
    } as any);
    const { client_id, client_secret } = await reg.json();
    await upsertClientPolicy(appPool, client_id, "SSO Live Allowed Client", [
      "env:dev",
      "env:live",
    ]);

    // Sign in via SSO to establish session (use fresh SSO-only user with no live grant)
    fakeIdp.setNextUser({
      sub: "rule2ssouser@harbor.demo",
      email: "rule2ssouser@harbor.demo",
      email_verified: true,
      name: "Rule 2 SSO User",
    });
    const { cookie: sessionCookie } = await ssoSignIn(db.auth, "test-oidc", "/");

    const { verifier, challenge } = pkcePair();
    const authorizeUrl = new URL("http://localhost:8722/api/auth/mcp/authorize");
    authorizeUrl.searchParams.set("client_id", client_id);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", "http://localhost:9999/callback");
    authorizeUrl.searchParams.set("scope", "env:live openid");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const res = await db.auth.handler(
      new Request(authorizeUrl, { headers: { cookie: sessionCookie } }),
    );

    const location = res.headers.get("location") ?? "";
    const code = new URL(location, "http://localhost").searchParams.get("code");
    expect(code).toBeTruthy();

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
    const body = await tokenRes.json();
    const scope = body.scope as string;

    expect(scope).not.toContain("env:live");
  });

  it("rule 3: both env:dev and env:live → redirect to env picker", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: {
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "SSO Both Envs Client",
      },
      asResponse: true,
    } as any);
    const { client_id } = await reg.json();
    await upsertClientPolicy(appPool, client_id, "SSO Both Envs Client", ["env:dev", "env:live"]);

    // Sign in via SSO to establish session and get the user ID
    fakeIdp.setNextUser({
      sub: "rule3ssouser@harbor.demo",
      email: "rule3ssouser@harbor.demo",
      email_verified: true,
      name: "Rule 3 SSO User",
    });
    const { cookie: sessionCookie } = await ssoSignIn(db.auth, "test-oidc", "/");

    // Get the new SSO user's ID from the database
    const userResult = await appPool.query(`select id from app."user" where email = $1`, [
      "rule3ssouser@harbor.demo",
    ]);
    const userId = userResult.rows[0].id;

    // Give this SSO user a live grant
    const grantId = await requestGrant(appPool, {
      userId,
      collection: "policies",
      env: "live",
      purposeLabel: "test",
      // `policies` is a file collection and declares no `id`; approveGrant refuses a field the
      // config never made grantable, and this grant only has to exist to make the user live-eligible.
      allowedFields: ["title"],
    });
    await approveGrant(appPool, harborCfg, grantId, "ana", {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const { challenge } = pkcePair();
    const authorizeUrl = new URL("http://localhost:8722/api/auth/mcp/authorize");
    authorizeUrl.searchParams.set("client_id", client_id);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", "http://localhost:9999/callback");
    authorizeUrl.searchParams.set("scope", "env:dev env:live openid");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const res = await db.auth.handler(
      new Request(authorizeUrl, { headers: { cookie: sessionCookie } }),
    );

    const location = res.headers.get("location") ?? "";
    // Should redirect to env picker, not to the callback
    expect(location).toContain("/oauth/env-picker");
  });
});
