import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupWebDb } from "./helpers/web-db";

let handle: Awaited<ReturnType<typeof setupWebDb>>;
const ORIGINAL_URL = process.env.BETTER_AUTH_URL;

beforeAll(async () => {
  handle = await setupWebDb("session-hardening");
}, 60_000);

afterAll(async () => {
  if (ORIGINAL_URL === undefined) delete process.env.BETTER_AUTH_URL;
  else process.env.BETTER_AUTH_URL = ORIGINAL_URL;
  vi.resetModules();
  await handle?.end();
});

// lib/auth reads BETTER_AUTH_URL at module load, so the scheme has to be set before the import
// rather than passed in — which is the whole reason the Secure flag can key off it at all.
async function authOn(baseUrl: string) {
  vi.resetModules();
  process.env.APP_DATABASE_URL = handle.appUrl;
  process.env.BETTER_AUTH_URL = baseUrl;
  return (await import("../lib/auth")).auth;
}

async function signInCookie(auth: Awaited<ReturnType<typeof authOn>>) {
  const res = await auth.api.signInEmail({
    body: { email: "ana@harbor.demo", password: "demo" },
    asResponse: true,
  });
  expect(res.status, "sign-in itself failed, so the cookie assertions mean nothing").toBe(200);
  return res.headers.get("set-cookie") ?? "";
}

describe("session cookie hardening", () => {
  it("marks the session cookie Secure, HttpOnly and SameSite=Lax on an https origin", async () => {
    const cookie = await signInCookie(await authOn("https://warehousd.example.com"));

    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    // Not Strict. The OAuth authorize step and the SSO callback both return through a cross-site
    // redirect, and a Strict cookie is withheld on that hop — the MCP connector would break.
    expect(cookie).not.toMatch(/SameSite=Strict/i);
  });

  it("omits Secure on a plain http origin so local development still works", async () => {
    const cookie = await signInCookie(await authOn("http://localhost:8722"));

    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).not.toMatch(/;\s*Secure/i);
  });

  it("expires the session in hours, not the default week", async () => {
    const auth = await authOn("http://localhost:8722");
    const res = await auth.api.signInEmail({
      body: { email: "ana@harbor.demo", password: "demo" },
      asResponse: true,
    });
    const cookie = res.headers.get("set-cookie") ?? "";

    const maxAge = /Max-Age=(\d+)/i.exec(cookie);
    expect(maxAge, "session cookie carries no Max-Age").not.toBeNull();
    const hours = Number(maxAge?.[1]) / 3600;
    expect(hours).toBeLessThanOrEqual(24);
    expect(hours).toBeGreaterThan(0);
  });
});

// Better Auth does not gate the credential endpoints on Origin — its `originCheck` guards routes
// carrying a redirect target and validates that URL, so `trustedOrigins` is an open-redirect
// allowlist, not a CSRF one. Verified against better-auth 1.6.25: a form-encoded cross-site POST
// to /sign-in/email returned 200 with a Set-Cookie. A form-encoded POST is a "simple request", so
// no CORS preflight stands in the way. middleware.ts is what closes it.
describe("credential-endpoint origin gate (middleware)", () => {
  async function post(origin: string | null, path = "/api/auth/sign-in/email") {
    const { middleware } = await import("../middleware");
    const { NextRequest } = await import("next/server");
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
    };
    if (origin) headers.origin = origin;
    return middleware(
      new NextRequest(
        new Request(`http://localhost:8722${path}`, {
          method: "POST",
          headers,
          body: "email=ana@harbor.demo&password=demo",
        }),
      ),
    );
  }

  // Every other test here calls middleware() directly, which proves the logic but not the
  // wiring: Next only invokes it for paths in `config.matcher`, so dropping the credential
  // entries would disable the gate entirely while leaving all of them green.
  it("is actually wired to the credential paths", async () => {
    const { config } = await import("../middleware");
    expect(config.matcher).toContain("/api/auth/sign-in/:path*");
    expect(config.matcher).toContain("/api/auth/sign-up/:path*");
  });

  it("refuses a cross-site form POST to sign-in", async () => {
    process.env.BETTER_AUTH_URL = "http://localhost:8722";
    const res = await post("https://evil.example.com");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "untrusted_origin" });
  });

  it("allows the deployment's own origin", async () => {
    process.env.BETTER_AUTH_URL = "http://localhost:8722";
    const res = await post("http://localhost:8722");
    expect(res.status).toBe(200);
  });

  it("allows an origin listed in WAREHOUSD_TRUSTED_ORIGINS", async () => {
    process.env.BETTER_AUTH_URL = "http://localhost:8722";
    const before = process.env.WAREHOUSD_TRUSTED_ORIGINS;
    process.env.WAREHOUSD_TRUSTED_ORIGINS = "https://staging.example.com";
    try {
      const res = await post("https://staging.example.com");
      expect(res.status).toBe(200);
    } finally {
      process.env.WAREHOUSD_TRUSTED_ORIGINS = before;
    }
  });

  // Browsers always send Origin cross-site, so its absence is a non-browser caller — curl, a
  // server, the CLI. Refusing those would break every scripted login for no security gain.
  it("allows a request with no Origin at all", async () => {
    process.env.BETTER_AUTH_URL = "http://localhost:8722";
    const res = await post(null);
    expect(res.status).toBe(200);
  });

  // The SAML assertion arrives as a cross-origin POST from the IdP. Gating it would break every
  // SAML login, so the gate is scoped to sign-in/sign-up and must not reach this path.
  it("does not gate the SAML assertion callback", async () => {
    process.env.BETTER_AUTH_URL = "http://localhost:8722";
    const res = await post("https://idp.example.com", "/api/auth/sso/saml2/sp/acs/keycloak-saml");
    expect(res.status).not.toBe(403);
  });
});
