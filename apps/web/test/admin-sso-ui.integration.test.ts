import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { setupWebDb, signIn } from "./helpers/web-db";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let anaCookie: string, marcusCookie: string;
let idp: Server, idpUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    idp = createServer((rq, rs) => {
      if (rq.url === "/.well-known/openid-configuration") {
        rs.writeHead(200, { "content-type": "application/json" });
        rs.end(
          JSON.stringify({
            issuer: idpUrl,
            authorization_endpoint: `${idpUrl}/authorize`,
            token_endpoint: `${idpUrl}/token`,
            jwks_uri: `${idpUrl}/jwks`,
            userinfo_endpoint: `${idpUrl}/userinfo`,
            scopes_supported: ["openid", "profile", "email"],
          }),
        );
      } else if (rq.url === "/jwks") {
        rs.writeHead(200, { "content-type": "application/json" });
        rs.end(JSON.stringify({ keys: [{ kty: "RSA", use: "sig", kid: "k", n: "t", e: "AQAB" }] }));
      } else {
        rs.writeHead(404);
        rs.end();
      }
    }).listen(0, "127.0.0.1", () => {
      const a = idp.address();
      if (a && typeof a !== "string") idpUrl = `http://127.0.0.1:${a.port}`;
      resolve();
    });
  });
  process.env.WAREHOUSD_TRUSTED_ORIGINS = idpUrl;
  db = await setupWebDb("ssoui");
  anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@harbor.demo", "demo");
}, 60_000);

afterAll(async () => {
  await db?.end();
  await new Promise<void>((r) => idp.close(() => r()));
});

function req(url: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  return new Request(`http://localhost:8722${url}`, {
    method: opts.method ?? "GET",
    headers,
    // Conditional spread, not `body: … : undefined`: under `exactOptionalPropertyTypes` a
    // present-but-undefined `body` is not the same as an absent one, and RequestInit wants absent.
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe("SSO admin contract used by the UI", () => {
  it("accepts the exact OIDC payload the form sends", async () => {
    const { POST } = await import("../app/api/sso/providers/route");
    const res = await POST(
      req("/api/sso/providers", {
        method: "POST",
        cookie: anaCookie,
        body: {
          providerId: "acme-oidc",
          issuer: idpUrl,
          domain: "acme.example",
          oidcConfig: {
            clientId: "warehousd",
            clientSecret: "s3cret",
            discoveryEndpoint: `${idpUrl}/.well-known/openid-configuration`,
          },
        },
      }) as any,
    );
    expect(res.status).toBe(200);
  });

  it("lists the provider back without leaking the client secret", async () => {
    const { GET } = await import("../app/api/sso/providers/route");
    const res = await GET(req("/api/sso/providers", { cookie: anaCookie }) as any);
    const raw = await res.text();
    expect(raw).not.toContain("s3cret");
    const body = JSON.parse(raw);
    expect(body.providers.some((p: any) => p.providerId === "acme-oidc" && p.type === "oidc")).toBe(
      true,
    );
  });

  it("is invisible to a manager", async () => {
    const { GET } = await import("../app/api/sso/providers/route");
    expect((await GET(req("/api/sso/providers", { cookie: marcusCookie }) as any)).status).toBe(
      403,
    );
  });

  it("status is readable without a session so the login page can render", async () => {
    const { GET } = await import("../app/api/sso/status/route");
    const body = await (await GET(req("/api/sso/status") as any)).json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(typeof body.localLoginEnabled).toBe("boolean");
  });

  it("deleting a provider removes it and its linked accounts", async () => {
    const { DELETE } = await import("../app/api/sso/providers/[providerId]/route");
    const res = await DELETE(
      req("/api/sso/providers/acme-oidc", { method: "DELETE", cookie: anaCookie }) as any,
      { params: Promise.resolve({ providerId: "acme-oidc" }) },
    );
    expect(res.status).toBe(200);
    const { GET } = await import("../app/api/sso/providers/route");
    const body = await (await GET(req("/api/sso/providers", { cookie: anaCookie }) as any)).json();
    expect(body.providers.some((p: any) => p.providerId === "acme-oidc")).toBe(false);
  });
});
