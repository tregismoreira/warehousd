import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { createServer, Server } from "node:http";
import { Pool } from "pg";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let miaCookie: string, marcusCookie: string, anaCookie: string;
let fakeIdpServer: Server;
let fakeIdpUrl: string;

beforeAll(async () => {
  // Start a minimal fake OIDC server
  await new Promise<void>((resolve) => {
    fakeIdpServer = createServer((req, res) => {
      if (req.url === "/.well-known/openid-configuration") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: fakeIdpUrl,
            authorization_endpoint: `${fakeIdpUrl}/authorize`,
            token_endpoint: `${fakeIdpUrl}/token`,
            jwks_uri: `${fakeIdpUrl}/jwks`,
            userinfo_endpoint: `${fakeIdpUrl}/userinfo`,
            scopes_supported: ["openid", "profile", "email"],
          }),
        );
      } else if (req.url === "/jwks") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            keys: [
              {
                kty: "RSA",
                use: "sig",
                kid: "fake-key-id",
                n: "test",
                e: "AQAB",
              },
            ],
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    }).listen(0, "127.0.0.1", () => {
      const addr = fakeIdpServer.address();
      if (addr && typeof addr !== "string") {
        fakeIdpUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });

  // Set up environment before importing auth
  process.env.WAREHOUSD_TRUSTED_ORIGINS = fakeIdpUrl;

  db = await setupWebDb("ssoadmin");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@harbor.demo", "demo");
  anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");
}, 60_000);

afterAll(async () => {
  await db?.end();
  if (fakeIdpServer) {
    await new Promise<void>((resolve) => {
      fakeIdpServer.close(() => resolve());
    });
  }
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

describe("SSO Admin Routes", () => {
  describe("POST /api/sso/providers (app-level, registerSSOProvider) — auth gate", () => {
    it("member (mia) cannot register → 403", async () => {
      const { POST } = await import("../app/api/sso/providers/route");
      const res = await POST(
        req("/api/sso/providers", {
          method: "POST",
          cookie: miaCookie,
          body: {
            issuer: fakeIdpUrl,
            type: "oidc",
          },
        }) as any,
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("forbidden");
    });

    it("manager (marcus) cannot register → 403", async () => {
      const { POST } = await import("../app/api/sso/providers/route");
      const res = await POST(
        req("/api/sso/providers", {
          method: "POST",
          cookie: marcusCookie,
          body: {
            issuer: fakeIdpUrl,
            type: "oidc",
          },
        }) as any,
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("forbidden");
    });
  });

  describe("GET /api/sso/providers (app-level)", () => {
    it("manager (marcus) cannot list → 403", async () => {
      const { GET } = await import("../app/api/sso/providers/route");
      const res = await GET(
        req("/api/sso/providers", {
          cookie: marcusCookie,
        }) as any,
      );
      expect(res.status).toBe(403);
    });

    it("admin can list providers and response contains no clientSecret", async () => {
      const { GET } = await import("../app/api/sso/providers/route");

      // List providers
      const listRes = await GET(
        req("/api/sso/providers", {
          cookie: anaCookie,
        }) as any,
      );
      expect(listRes.status).toBe(200);

      // Create a new Response to read the body without affecting the clone
      const clonedRes = listRes.clone();
      const body = await listRes.json();
      expect(Array.isArray(body.providers)).toBe(true);

      const responseText = await clonedRes.text();
      expect(responseText).not.toContain("clientSecret");
    });
  });

  describe("GET /api/sso/status (public, no auth)", () => {
    it("returns providers and localLoginEnabled with no clientSecret", async () => {
      const { GET } = await import("../app/api/sso/status/route");
      const res = await GET(req("/api/sso/status") as any);
      expect(res.status).toBe(200);

      const clonedRes = res.clone();
      const body = await res.json();
      expect(body).toHaveProperty("providers");
      expect(body).toHaveProperty("localLoginEnabled");
      expect(Array.isArray(body.providers)).toBe(true);

      const responseText = await clonedRes.text();
      expect(responseText).not.toContain("clientSecret");
    });
  });

  describe("Provider deletion by different admins", () => {
    it("provider created by one admin can be deleted by another admin user", async () => {
      const appPool = new Pool({ connectionString: db.appUrl });

      // Create a second admin user
      const res = await db.auth.api.signUpEmail({
        body: { email: "admin2@test.demo", password: "demo", name: "Admin2" },
      });
      const admin2Id = res.user.id;

      // Set role to admin. Authorization reads app.workspace_members (lib/authz.ts), not this
      // column, so both have to be set — the account-level role is UX-only, same as
      // entrypoint.ts's ensureAdminUser and dev-bootstrap.ts's persona seeding.
      await appPool.query(`set session_replication_role = replica`);
      await appPool.query(`update app."user" set role='admin' where id=$1`, [admin2Id]);
      await appPool.query(`set session_replication_role = default`);
      await appPool.query(
        `update app.workspace_members set role='admin' where workspace_id='default' and user_id=$1`,
        [admin2Id],
      );

      // Sign in as second admin
      const admin2Cookie = await signIn(db.auth, "admin2@test.demo", "demo");

      // Insert a test provider directly into the database (simulating one registered by ana)
      const providerId = "test-provider-" + Date.now();
      const crypto = await import("node:crypto");
      const id = crypto.randomUUID();
      await appPool.query(
        `insert into app."ssoProvider" (id, "providerId", issuer, domain, "userId", "organizationId") values ($1, $2, $3, $4, $5, $6)`,
        [id, providerId, fakeIdpUrl, "test.example.com", "ana", null],
      );

      // List providers as ana to verify it exists
      const { GET } = await import("../app/api/sso/providers/route");
      const listRes = await GET(
        req("/api/sso/providers", {
          cookie: anaCookie,
        }) as any,
      );
      const listBody = await listRes.json();
      expect(listBody.providers.some((p: any) => p.providerId === providerId)).toBe(true);

      // Delete provider as admin2
      const { DELETE } = await import("../app/api/sso/providers/[providerId]/route");
      const deleteRes = await DELETE(
        req(`/api/sso/providers/${providerId}`, {
          method: "DELETE",
          cookie: admin2Cookie,
        }) as any,
        { params: Promise.resolve({ providerId }) },
      );
      expect(deleteRes.status).toBe(200);

      // Verify it's deleted
      const listRes2 = await GET(
        req("/api/sso/providers", {
          cookie: anaCookie,
        }) as any,
      );
      const listBody2 = await listRes2.json();
      expect(listBody2.providers.some((p: any) => p.providerId === providerId)).toBe(false);

      await appPool.end();
    });
  });

  describe("Raw Better Auth endpoints (5a: ssoAdminPlugin hook)", () => {
    describe("POST /api/auth/sso/register (raw, via db.auth.handler)", () => {
      it("member (mia) cannot register → 403", async () => {
        const res = await db.auth.handler(
          req("/api/auth/sso/register", {
            method: "POST",
            cookie: miaCookie,
            body: {
              issuer: fakeIdpUrl,
              type: "oidc",
            },
          }),
        );
        expect(res.status).toBe(403);
      });

      it("manager (marcus) cannot register → 403", async () => {
        const res = await db.auth.handler(
          req("/api/auth/sso/register", {
            method: "POST",
            cookie: marcusCookie,
            body: {
              issuer: fakeIdpUrl,
              type: "oidc",
            },
          }),
        );
        expect(res.status).toBe(403);
      });

      it("admin (ana) can register → succeeds", async () => {
        const res = await db.auth.handler(
          req("/api/auth/sso/register", {
            method: "POST",
            cookie: anaCookie,
            body: {
              providerId: "admin-register-test-provider",
              issuer: fakeIdpUrl,
              domain: "test.example.com",
              oidcConfig: {
                clientId: "test-client-id",
                clientSecret: "test-client-secret",
                discoveryEndpoint: `${fakeIdpUrl}/.well-known/openid-configuration`,
              },
            },
          }),
        );
        expect([200, 201]).toContain(res.status);
        const body = await res.json();
        expect(body.id || body.providerId).toBeDefined();
      });
    });

    describe("GET /api/auth/sso/providers (raw, via db.auth.handler)", () => {
      it("manager (marcus) cannot list → 403", async () => {
        const res = await db.auth.handler(
          req("/api/auth/sso/providers", {
            method: "GET",
            cookie: marcusCookie,
          }),
        );
        expect(res.status).toBe(403);
      });
    });
  });
});
