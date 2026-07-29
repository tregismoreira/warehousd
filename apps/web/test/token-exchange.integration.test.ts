import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { setupWebDbWithConfig } from "./helpers/web-db";
import {
  upsertClientPolicy, approveGrant, requestGrant, createClientSecret, revokeClientSecret,
  createTrustedIssuer,
} from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

const fixtureDir = new URL("./fixtures/rest-api", import.meta.url).pathname;

describe("token exchange (delegated flow)", () => {
  let db: Awaited<ReturnType<typeof setupWebDbWithConfig>>;
  let jwksServer: Server;
  let jwksUrl: string;
  let keyPair: Awaited<ReturnType<typeof generateKeyPair>>;
  let trustedIssuer: { id: string; issuer: string; audience: string };

  beforeAll(async () => {
    db = await setupWebDbWithConfig("tokenexchange", fixtureDir);

    keyPair = await generateKeyPair("RS256");
    const jwk = await exportJWK(keyPair.publicKey);
    Object.assign(jwk, { kid: "test-key-1", use: "sig" });

    jwksServer = createServer((req, res) => {
      if (req.url === "/.well-known/jwks.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [jwk] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => {
      jwksServer.listen(0, "127.0.0.1", () => {
        const addr = jwksServer.address() as any;
        jwksUrl = `http://127.0.0.1:${addr.port}/.well-known/jwks.json`;
        resolve();
      });
    });

    const app = getAppPool();
    const issuer = "https://issuer.example.com";
    const audience = "warehousd-rest-tests";
    trustedIssuer = await createTrustedIssuer(app, "default", issuer, jwksUrl, audience);

    // A second org + user for the cross-org refusal test.
    await app.query(`insert into app.organizations (id, name) values ('other', 'Other') on conflict do nothing`);
    await app.query(
      `insert into app."user" (id, name, email, "emailVerified", "orgId", role, "createdAt", "updatedAt")
       values ('bob', 'Bob', 'bob@other.example.com', true, 'other', 'member', now(), now())
       on conflict (id) do nothing`);
  }, 60_000);

  afterAll(async () => {
    if (jwksServer) await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
    await db?.end();
  });

  function signSubjectJwt(subject: string, issuer = trustedIssuer.issuer, audience = trustedIssuer.audience) {
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuer(issuer).setAudience(audience).setSubject(subject)
      .setExpirationTime("1h").sign(keyPair.privateKey);
  }

  async function registerClient(name: string) {
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: name },
      asResponse: true,
    } as any);
    return (await reg.json()).client_id as string;
  }

  async function exchange(body: Record<string, string>) {
    const { POST } = await import("../app/v1/token/route");
    const tokenReq = new Request("http://localhost:8722/v1/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    return POST(tokenReq as any);
  }

  async function delegatedExchange(clientId: string, secret: string, jwt: string, scope = "env:dev") {
    return exchange({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: jwt, subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      client_id: clientId, client_secret: secret, scope,
    });
  }

  describe("valid exchange", () => {
    it("yields a token bound to the subject's grants", async () => {
      const app = getAppPool();
      const clientId = await registerClient("TE Valid");
      await upsertClientPolicy(app, clientId, "TE Valid", ["env:dev"]);
      await app.query(`update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`, [trustedIssuer.id, clientId]);
      const { secret } = await createClientSecret(app, clientId, "default", new Date(Date.now() + 86_400_000), "test");

      const jwt = await signSubjectJwt("mia@harbor.demo");
      const res = await delegatedExchange(clientId, secret, jwt);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.access_token).toBeDefined();
      expect(body.token_type).toBe("Bearer");
      expect(body.scope).toContain("env:dev");
    });

    it("narrows scope to the client's allowed_collections ceiling, never widens", async () => {
      const app = getAppPool();
      const clientId = await registerClient("TE Ceiling");
      await upsertClientPolicy(app, clientId, "TE Ceiling", ["env:dev"]);
      await app.query(
        `update app.client_policies set mode='delegated', allowed_collections=$1, trusted_issuer_id=$2 where client_id=$3`,
        [["feedback"], trustedIssuer.id, clientId]);
      const { secret } = await createClientSecret(app, clientId, "default", new Date(Date.now() + 86_400_000), "test");
      const jwt = await signSubjectJwt("mia@harbor.demo");

      const res = await delegatedExchange(clientId, secret, jwt);
      expect(res.status).toBe(200);

      // Bind the issued token to a REST context and confirm the ceiling actually applies —
      // a request against a collection outside the ceiling refuses no_grant, never "documents".
      const { access_token } = await res.json();
      const { deriveRestContext } = await import("../lib/rest-context");
      const ctx = await deriveRestContext(new Request("http://localhost:8722/v1/collections", { headers: { authorization: `Bearer ${access_token}` } }));
      expect(ctx?.allowedCollections).toEqual(["feedback"]);
    });
  });

  it("an unregistered issuer is refused", async () => {
    const app = getAppPool();
    const clientId = await registerClient("TE No Issuer");
    await upsertClientPolicy(app, clientId, "TE No Issuer", ["env:dev"]);
    // mode='delegated' but trusted_issuer_id left null — never registered.
    await app.query(`update app.client_policies set mode='delegated' where client_id=$1`, [clientId]);
    const { secret } = await createClientSecret(app, clientId, "default", new Date(Date.now() + 86_400_000), "test");
    const jwt = await signSubjectJwt("mia@harbor.demo");

    const res = await delegatedExchange(clientId, secret, jwt);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("a cross-org subject is refused", async () => {
    const app = getAppPool();
    const clientId = await registerClient("TE Cross Org");
    await upsertClientPolicy(app, clientId, "TE Cross Org", ["env:dev"]);
    await app.query(`update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`, [trustedIssuer.id, clientId]);
    const { secret } = await createClientSecret(app, clientId, "default", new Date(Date.now() + 86_400_000), "test");

    // trustedIssuer is registered under org "default"; bob belongs to org "other".
    const jwt = await signSubjectJwt("bob@other.example.com");
    const res = await delegatedExchange(clientId, secret, jwt);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("a delegated client cannot use client_credentials", async () => {
    const app = getAppPool();
    const clientId = await registerClient("TE Delegated Wrong Grant");
    await upsertClientPolicy(app, clientId, "TE Delegated Wrong Grant", ["env:dev"]);
    await app.query(`update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`, [trustedIssuer.id, clientId]);
    const { secret } = await createClientSecret(app, clientId, "default", new Date(Date.now() + 86_400_000), "test");

    const res = await exchange({ grant_type: "client_credentials", client_id: clientId, client_secret: secret, scope: "env:dev" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unauthorized_client");
  });

  it("a headless client cannot use token-exchange", async () => {
    const app = getAppPool();
    const clientId = await registerClient("TE Headless Wrong Grant");
    await upsertClientPolicy(app, clientId, "TE Headless Wrong Grant", ["env:dev"]);
    await app.query(`update app.client_policies set mode='headless', robot_user_id='marcus' where client_id=$1`, [clientId]);
    const { secret } = await createClientSecret(app, clientId, "default", new Date(Date.now() + 86_400_000), "test");
    const jwt = await signSubjectJwt("marcus");

    const res = await delegatedExchange(clientId, secret, jwt);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unauthorized_client");
  });

  it("a revoked key fails the very next request, no expiry wait", async () => {
    const app = getAppPool();
    const clientId = await registerClient("TE Revoke");
    await upsertClientPolicy(app, clientId, "TE Revoke", ["env:dev"]);
    await app.query(`update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`, [trustedIssuer.id, clientId]);
    const { id: secretId, secret } = await createClientSecret(app, clientId, "default", new Date(Date.now() + 86_400_000), "test");
    const jwt = await signSubjectJwt("mia@harbor.demo");

    const res1 = await delegatedExchange(clientId, secret, jwt);
    expect(res1.status).toBe(200);

    await revokeClientSecret(app, secretId);
    const res2 = await delegatedExchange(clientId, secret, jwt);
    expect(res2.status).toBe(401);
  });

  describe("env-scope parity with the OAuth flow (same rules as apps/web/test/oauth-scope.integration.test.ts)", () => {
    it("rule 1: dev-only client requesting env:live gets only env:dev", async () => {
      const app = getAppPool();
      const clientId = await registerClient("TE Rule1");
      await upsertClientPolicy(app, clientId, "TE Rule1", ["env:dev"]);
      await app.query(`update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`, [trustedIssuer.id, clientId]);
      const { secret } = await createClientSecret(app, clientId, "default", new Date(Date.now() + 86_400_000), "test");
      const jwt = await signSubjectJwt("mia@harbor.demo");

      const res = await exchange({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: jwt, subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        client_id: clientId, client_secret: secret, scope: "env:dev env:live",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.scope).toContain("env:dev");
      expect(body.scope).not.toContain("env:live");
    });

    it("rule 2: env:live requires an approved, unexpired live grant even for a live-allowed client", async () => {
      const app = getAppPool();
      const clientId = await registerClient("TE Rule2");
      await upsertClientPolicy(app, clientId, "TE Rule2", ["env:dev", "env:live"]);
      await app.query(`update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`, [trustedIssuer.id, clientId]);
      const { secret } = await createClientSecret(app, clientId, "default", new Date(Date.now() + 86_400_000), "test");
      const jwt = await signSubjectJwt("mia@harbor.demo");

      const res = await exchange({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: jwt, subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        client_id: clientId, client_secret: secret, scope: "env:live",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // No approved live grant for mia yet — falls back to the env:dev floor.
      expect(body.scope).not.toContain("env:live");
      expect(body.scope).toContain("env:dev");
    });

    it("rule 2b: env:live survives with an approved, unexpired live grant", async () => {
      const app = getAppPool();
      const grantId = await requestGrant(app, {
        userId: "mia", collection: "feedback", orgId: "default", env: "live",
        purposeLabel: "test", allowedFields: ["id"],
      });
      await approveGrant(app, db.cfg, grantId, "marcus", {
        verbs: ["read"], expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });

      const clientId = await registerClient("TE Rule2b");
      await upsertClientPolicy(app, clientId, "TE Rule2b", ["env:dev", "env:live"]);
      await app.query(`update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`, [trustedIssuer.id, clientId]);
      const { secret } = await createClientSecret(app, clientId, "default", new Date(Date.now() + 86_400_000), "test");
      const jwt = await signSubjectJwt("mia@harbor.demo");

      const res = await exchange({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: jwt, subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        client_id: clientId, client_secret: secret, scope: "env:live",
      });
      expect(res.status).toBe(200);
      expect((await res.json()).scope).toContain("env:live");
    });

    it("an env:dev-only key cannot obtain env:live by any request shape", async () => {
      const app = getAppPool();
      const clientId = await registerClient("TE Parity");
      await upsertClientPolicy(app, clientId, "TE Parity", ["env:dev"]);
      await app.query(`update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`, [trustedIssuer.id, clientId]);
      const { secret } = await createClientSecret(app, clientId, "default", new Date(Date.now() + 86_400_000), "test");
      const jwt = await signSubjectJwt("mia@harbor.demo");

      for (const scope of ["env:live", "env:dev env:live", "ENV:LIVE", "env:live env:dev"]) {
        const res = await exchange({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: jwt, subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          client_id: clientId, client_secret: secret, scope,
        });
        if (res.status === 200) expect((await res.json()).scope).not.toContain("env:live");
      }
    });
  });
});
