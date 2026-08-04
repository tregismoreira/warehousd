import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";
import { listClientSecrets } from "@warehousd/broker";
import { must } from "./helpers/must";

describe("Control-plane API routes", () => {
  let db: Awaited<ReturnType<typeof setupWebDb>>;
  let adminCookie: string;
  let memberCookie: string;

  function apiRequest(
    path: string,
    opts: { method?: string; body?: unknown; cookie?: string } = {},
  ) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.cookie) headers["cookie"] = opts.cookie;
    return new Request(`http://localhost:8722${path}`, {
      method: opts.method ?? "GET",
      headers,
      // Conditional spread, not `body: … : undefined`: under `exactOptionalPropertyTypes` a
      // present-but-undefined `body` is not the same as an absent one, and RequestInit wants absent.
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }) as any;
  }

  beforeAll(async () => {
    db = await setupWebDb("apikeys");
    adminCookie = await signIn(db.auth, "ana@harbor.demo", "demo");
    memberCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
  }, 60_000);

  afterAll(async () => {
    await db?.end();
  });

  describe("POST /api/api-keys", () => {
    it("creates a new API key with headless mode", async () => {
      const { POST } = await import("../app/api/api-keys/route");
      const req = apiRequest("/api/api-keys", {
        method: "POST",
        cookie: adminCookie,
        body: {
          name: "Test Key",
          mode: "headless",
          robotUserId: "test-robot",
          allowedCollections: ["collection1"],
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      });
      const res = await POST(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.clientId).toBeDefined();
      expect(data.secret).toBeDefined();
      expect(data.secret).toMatch(/^whd_dev_/);
    });

    it("creates a new API key with delegated mode", async () => {
      const app = getAppPool();
      const org = "default";
      // Create a trusted issuer first
      const issuerRes = await app.query(
        `insert into app.trusted_issuers (org_id, issuer, jwks_uri, audience, subject_claim)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [
          org,
          "https://issuer.example.com",
          "https://issuer.example.com/.well-known/jwks.json",
          "my-app",
          "sub",
        ],
      );
      const issuerId = issuerRes.rows[0].id;

      const { POST } = await import("../app/api/api-keys/route");
      const req = apiRequest("/api/api-keys", {
        method: "POST",
        cookie: adminCookie,
        body: {
          name: "Delegated Key",
          mode: "delegated",
          trustedIssuerId: issuerId,
          allowedCollections: ["collection2"],
        },
      });
      const res = await POST(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.clientId).toBeDefined();
      expect(data.secret).toBeDefined();
    });

    // The env is chosen once, at mint time, and encoded in the prefix. Before this there was no
    // way to ask for a live key at all, which is why the prefix could not be a ceiling: enforcing
    // it would have capped every client at dev with no opt-out.
    it("mints a live-prefixed key when asked, with a policy that allows env:live", async () => {
      const app = getAppPool();
      const { POST } = await import("../app/api/api-keys/route");
      const res = await POST(
        apiRequest("/api/api-keys", {
          method: "POST",
          cookie: adminCookie,
          body: { name: "Live Key", mode: "headless", robotUserId: "robot-live", env: "live" },
        }),
      );
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.env).toBe("live");
      expect(data.secret).toMatch(/^whd_live_/);

      const policy = await app.query(
        `select allowed_scopes from app.client_policies where client_id=$1`,
        [data.clientId],
      );
      // Both, not live alone: live is the ceiling, not an exclusive mode.
      expect(policy.rows[0].allowed_scopes).toEqual(["env:dev", "env:live"]);
    });

    it("defaults to dev, with a policy that allows no live at all", async () => {
      const app = getAppPool();
      const { POST } = await import("../app/api/api-keys/route");
      const res = await POST(
        apiRequest("/api/api-keys", {
          method: "POST",
          cookie: adminCookie,
          body: { name: "Default Env Key", mode: "headless", robotUserId: "robot-default-env" },
        }),
      );
      const data = await res.json();
      expect(data.env).toBe("dev");
      expect(data.secret).toMatch(/^whd_dev_/);

      const policy = await app.query(
        `select allowed_scopes from app.client_policies where client_id=$1`,
        [data.clientId],
      );
      expect(policy.rows[0].allowed_scopes).toEqual(["env:dev"]);
    });

    // Refused rather than coerced to dev: a typo that silently produced a dev key would surface
    // later as an unexplained invalid_scope, a long way from the request that caused it.
    it("refuses an env that is neither dev nor live", async () => {
      const { POST } = await import("../app/api/api-keys/route");
      const res = await POST(
        apiRequest("/api/api-keys", {
          method: "POST",
          cookie: adminCookie,
          body: { name: "Bad Env Key", mode: "headless", robotUserId: "robot-bad", env: "staging" },
        }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_env");
    });

    it("rejects headless mode without robotUserId", async () => {
      const { POST } = await import("../app/api/api-keys/route");
      const req = apiRequest("/api/api-keys", {
        method: "POST",
        cookie: adminCookie,
        body: {
          name: "Bad Key",
          mode: "headless",
        },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("headless_mode_requires_robot_user_id");
    });

    it("rejects delegated mode without trustedIssuerId", async () => {
      const { POST } = await import("../app/api/api-keys/route");
      const req = apiRequest("/api/api-keys", {
        method: "POST",
        cookie: adminCookie,
        body: {
          name: "Bad Key",
          mode: "delegated",
        },
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("delegated_mode_requires_trusted_issuer");
    });

    it("rejects non-admin", async () => {
      const { POST } = await import("../app/api/api-keys/route");
      const req = apiRequest("/api/api-keys", {
        method: "POST",
        cookie: memberCookie,
        body: { name: "Test", mode: "headless", robotUserId: "robot" },
      });
      const res = await POST(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe("forbidden");
    });
  });

  describe("GET /api/api-keys", () => {
    it("lists API keys for admin", async () => {
      const { POST } = await import("../app/api/api-keys/route");
      const req = apiRequest("/api/api-keys", {
        method: "POST",
        cookie: adminCookie,
        body: {
          name: "Key for List",
          mode: "headless",
          robotUserId: "robot-list",
        },
      });
      await POST(req);

      const { GET } = await import("../app/api/api-keys/route");
      const getReq = apiRequest("/api/api-keys", { cookie: adminCookie });
      const res = await GET(getReq);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.keys)).toBe(true);
      expect(data.keys.length).toBeGreaterThan(0);

      const key = data.keys.find((k: any) => k.displayName === "Key for List");
      expect(key).toBeDefined();
      expect(key.mode).toBe("headless");
      expect(key.robotUserId).toBe("robot-list");
      expect(Array.isArray(key.secrets)).toBe(true);
      expect(key.secrets.length).toBeGreaterThan(0);
      // Secrets should NOT contain the plaintext secret or hash
      expect(key.secrets[0]).not.toHaveProperty("secret");
      expect(key.secrets[0]).toHaveProperty("prefix");
      expect(key.secrets[0]).toHaveProperty("createdAt");
    });

    it("rejects non-admin", async () => {
      const { GET } = await import("../app/api/api-keys/route");
      const req = apiRequest("/api/api-keys", { cookie: memberCookie });
      const res = await GET(req);
      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/api-keys/[id]/rotate", () => {
    it("rotates a secret", async () => {
      const app = getAppPool();
      const { POST: create } = await import("../app/api/api-keys/route");
      const createReq = apiRequest("/api/api-keys", {
        method: "POST",
        cookie: adminCookie,
        body: {
          name: "Key to Rotate",
          mode: "headless",
          robotUserId: "robot-rotate",
        },
      });
      const createRes = await create(createReq);
      const { clientId, secret: oldSecret } = await createRes.json();

      // Get the old secret id
      const secrets = await listClientSecrets(app, clientId, "default");
      const oldSecretId = must(secrets[0], "a client secret for the new key").id;

      const { POST } = await import("../app/api/api-keys/[id]/rotate/route");
      const rotateReq = apiRequest(`/api/api-keys/${clientId}/rotate`, {
        method: "POST",
        cookie: adminCookie,
        body: { oldSecretId, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      });
      const res = await POST(rotateReq, { params: Promise.resolve({ id: clientId }) });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.secret).toBeDefined();
      expect(data.id).toBeDefined();
      expect(data.secret).not.toEqual(oldSecret);

      // Verify both secrets exist (rotation allows 2 concurrent secrets)
      const rotatedSecrets = await listClientSecrets(app, clientId, "default");
      expect(rotatedSecrets.length).toBe(2);
      expect(rotatedSecrets.some((s) => s.id === oldSecretId)).toBe(true);
      expect(rotatedSecrets.every((s) => !s.revokedAt)).toBe(true);
    });

    // Rotation replaces a credential; it does not re-scope one. A live key coming back capped at
    // dev would break the deployment mid-rotation, and the reverse would be an escalation.
    it("keeps the rotated key's environment", async () => {
      const app = getAppPool();
      const { POST: create } = await import("../app/api/api-keys/route");
      const createRes = await create(
        apiRequest("/api/api-keys", {
          method: "POST",
          cookie: adminCookie,
          body: {
            name: "Live Key to Rotate",
            mode: "headless",
            robotUserId: "robot-rotate-live",
            env: "live",
          },
        }),
      );
      const { clientId } = await createRes.json();
      const oldSecretId = must(
        (await listClientSecrets(app, clientId, "default"))[0],
        "a client secret for the new live key",
      ).id;

      const { POST } = await import("../app/api/api-keys/[id]/rotate/route");
      const res = await POST(
        apiRequest(`/api/api-keys/${clientId}/rotate`, {
          method: "POST",
          cookie: adminCookie,
          body: { oldSecretId },
        }),
        { params: Promise.resolve({ id: clientId }) },
      );
      expect(res.status).toBe(201);
      expect((await res.json()).secret).toMatch(/^whd_live_/);
    });

    it("plaintext secret appears only once", async () => {
      const { POST: create } = await import("../app/api/api-keys/route");
      const createReq = apiRequest("/api/api-keys", {
        method: "POST",
        cookie: adminCookie,
        body: {
          name: "Key for Secret Test",
          mode: "headless",
          robotUserId: "robot-secret",
        },
      });
      const createRes = await create(createReq);
      const createData = await createRes.json();
      const secret = createData.secret;

      // Verify it's in the response
      expect(secret).toBeDefined();

      // Get the key and verify the secret is NOT in the metadata
      const { GET } = await import("../app/api/api-keys/route");
      const getReq = apiRequest("/api/api-keys", { cookie: adminCookie });
      const getRes = await GET(getReq);
      const data = await getRes.json();
      const key = data.keys.find((k: any) => k.displayName === "Key for Secret Test");
      expect(key.secrets[0].secret).toBeUndefined();
      expect(key.secrets[0].prefix).toBeDefined();
    });

    it("rejects non-admin", async () => {
      const { POST } = await import("../app/api/api-keys/[id]/rotate/route");
      const req = apiRequest("/api/api-keys/fake-id/rotate", {
        method: "POST",
        cookie: memberCookie,
        body: { oldSecretId: "fake" },
      });
      const res = await POST(req, { params: Promise.resolve({ id: "fake-id" }) });
      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/api-keys/[id]/revoke", () => {
    it("revokes a secret", async () => {
      const app = getAppPool();
      const { POST: create } = await import("../app/api/api-keys/route");
      const createReq = apiRequest("/api/api-keys", {
        method: "POST",
        cookie: adminCookie,
        body: {
          name: "Key to Revoke",
          mode: "headless",
          robotUserId: "robot-revoke",
        },
      });
      const createRes = await create(createReq);
      const { clientId } = await createRes.json();

      const secrets = await listClientSecrets(app, clientId, "default");
      const secretId = must(secrets[0], "a client secret for the new key").id;

      const { POST } = await import("../app/api/api-keys/[id]/revoke/route");
      const revokeReq = apiRequest(`/api/api-keys/${clientId}/revoke`, {
        method: "POST",
        cookie: adminCookie,
        body: { secretId },
      });
      const res = await POST(revokeReq, { params: Promise.resolve({ id: clientId }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);

      // Verify the secret is revoked
      const revokedSecrets = await listClientSecrets(app, clientId, "default");
      const revoked = revokedSecrets.find((s) => s.id === secretId);
      expect(revoked?.revokedAt).toBeDefined();
    });

    it("rejects non-admin", async () => {
      const { POST } = await import("../app/api/api-keys/[id]/revoke/route");
      const req = apiRequest("/api/api-keys/fake-id/revoke", {
        method: "POST",
        cookie: memberCookie,
        body: { secretId: "fake" },
      });
      const res = await POST(req, { params: Promise.resolve({ id: "fake-id" }) });
      expect(res.status).toBe(403);
    });

    it("refuses to revoke a secret that belongs to a different client", async () => {
      const app = getAppPool();
      const { POST: create } = await import("../app/api/api-keys/route");

      const req1 = apiRequest("/api/api-keys", {
        method: "POST",
        cookie: adminCookie,
        body: { name: "Owner A", mode: "headless", robotUserId: "robot-a" },
      });
      const { clientId: clientA } = await (await create(req1)).json();

      const req2 = apiRequest("/api/api-keys", {
        method: "POST",
        cookie: adminCookie,
        body: { name: "Owner B", mode: "headless", robotUserId: "robot-b" },
      });
      const { clientId: clientB } = await (await create(req2)).json();

      const secretsB = await listClientSecrets(app, clientB, "default");
      const secretIdB = must(secretsB[0], "a client secret for owner B's key").id;

      // Revoke B's secret through A's URL — must refuse, not silently revoke a secret it
      // doesn't own.
      const { POST } = await import("../app/api/api-keys/[id]/revoke/route");
      const res = await POST(
        apiRequest(`/api/api-keys/${clientA}/revoke`, {
          method: "POST",
          cookie: adminCookie,
          body: { secretId: secretIdB },
        }),
        { params: Promise.resolve({ id: clientA }) },
      );
      expect(res.status).toBe(404);

      const stillLive = await listClientSecrets(app, clientB, "default");
      expect(stillLive.find((s) => s.id === secretIdB)?.revokedAt).toBeNull();
    });
  });

  describe("PATCH /api/api-keys/[id]", () => {
    it("updates allowed collections", async () => {
      const app = getAppPool();
      const { POST: create } = await import("../app/api/api-keys/route");
      const createReq = apiRequest("/api/api-keys", {
        method: "POST",
        cookie: adminCookie,
        body: {
          name: "Key for Patch",
          mode: "headless",
          robotUserId: "robot-patch",
          allowedCollections: ["col1"],
        },
      });
      const createRes = await create(createReq);
      const { clientId } = await createRes.json();

      const { PATCH } = await import("../app/api/api-keys/[id]/route");
      const patchReq = apiRequest(`/api/api-keys/${clientId}`, {
        method: "PATCH",
        cookie: adminCookie,
        body: { allowedCollections: ["col1", "col2", "col3"] },
      });
      const res = await PATCH(patchReq, { params: Promise.resolve({ id: clientId }) });
      expect(res.status).toBe(200);

      // Verify the update
      const r = await app.query(
        `select allowed_collections from app.client_policies where client_id=$1`,
        [clientId],
      );
      expect(r.rows[0].allowed_collections).toEqual(["col1", "col2", "col3"]);
    });

    it("rejects non-admin", async () => {
      const { PATCH } = await import("../app/api/api-keys/[id]/route");
      const req = apiRequest("/api/api-keys/fake-id", {
        method: "PATCH",
        cookie: memberCookie,
        body: { allowedCollections: ["col1"] },
      });
      const res = await PATCH(req, { params: Promise.resolve({ id: "fake-id" }) });
      expect(res.status).toBe(403);
    });
  });

  describe("GET/POST /api/trusted-issuers", () => {
    it("creates a trusted issuer", async () => {
      const { POST } = await import("../app/api/trusted-issuers/route");
      const req = apiRequest("/api/trusted-issuers", {
        method: "POST",
        cookie: adminCookie,
        body: {
          issuer: "https://auth.example.com",
          jwksUri: "https://auth.example.com/.well-known/jwks.json",
          audience: "my-app",
        },
      });
      const res = await POST(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.issuer).toBeDefined();
      expect(data.issuer.id).toBeDefined();
      expect(data.issuer.issuer).toBe("https://auth.example.com");
    });

    it("lists trusted issuers", async () => {
      const { GET } = await import("../app/api/trusted-issuers/route");
      const req = apiRequest("/api/trusted-issuers", { cookie: adminCookie });
      const res = await GET(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.issuers)).toBe(true);
    });

    it("rejects non-admin", async () => {
      const { GET } = await import("../app/api/trusted-issuers/route");
      const req = apiRequest("/api/trusted-issuers", { cookie: memberCookie });
      const res = await GET(req);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/proposals", () => {
    it("requires session auth", async () => {
      const { GET } = await import("../app/api/proposals/route");
      const req = apiRequest("/api/proposals", {});
      const res = await GET(req);
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/proposals/[id]/approve and reject", () => {
    it("requires session auth", async () => {
      const { POST } = await import("../app/api/proposals/[id]/approve/route");
      const req = apiRequest("/api/proposals/fake-id/approve", { method: "POST" });
      const res = await POST(req, { params: Promise.resolve({ id: "fake-id" }) });
      expect(res.status).toBe(401);
    });

    it("requires valid session for reject", async () => {
      const { POST } = await import("../app/api/proposals/[id]/reject/route");
      const req = apiRequest("/api/proposals/fake-id/reject", { method: "POST" });
      const res = await POST(req, { params: Promise.resolve({ id: "fake-id" }) });
      expect(res.status).toBe(401);
    });
  });

  // The two reads the review queue depends on. Both delegate authorization to the broker, so
  // the contract to hold here is that an unauthenticated caller never reaches it at all.
  describe("GET /api/proposals/[id]", () => {
    it("requires session auth", async () => {
      const { GET } = await import("../app/api/proposals/[id]/route");
      const req = apiRequest("/api/proposals/fake-id", {});
      const res = await GET(req, { params: Promise.resolve({ id: "fake-id" }) });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/collections/[c]/documents/[id]", () => {
    it("requires session auth", async () => {
      const { GET } = await import("../app/api/collections/[c]/documents/[id]/route");
      const req = apiRequest("/api/collections/people/documents/fake-id", {});
      const res = await GET(req, { params: Promise.resolve({ c: "people", id: "fake-id" }) });
      expect(res.status).toBe(401);
    });
  });
});
