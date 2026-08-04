import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { setupWebDbWithConfig } from "./helpers/web-db";
import {
  upsertClientPolicy,
  approveGrant,
  requestGrant,
  createClientSecret,
  revokeClientSecret,
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
  // Counts real hits on the JWKS endpoint, so the key-set cache can be asserted rather than
  // assumed: a per-request createRemoteJWKSet threw its cache away and refetched every time.
  let jwksFetches = 0;

  beforeAll(async () => {
    db = await setupWebDbWithConfig("tokenexchange", fixtureDir);

    keyPair = await generateKeyPair("RS256");
    const jwk = await exportJWK(keyPair.publicKey);
    Object.assign(jwk, { kid: "test-key-1", use: "sig" });

    jwksServer = createServer((req, res) => {
      if (req.url === "/.well-known/jwks.json") {
        jwksFetches++;
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
    await app.query(
      `insert into app.organizations (id, name) values ('other', 'Other') on conflict do nothing`,
    );
    await app.query(
      `insert into app."user" (id, name, email, "emailVerified", "orgId", role, "createdAt", "updatedAt")
       values ('bob', 'Bob', 'bob@other.example.com', true, 'other', 'member', now(), now())
       on conflict (id) do nothing`,
    );
  }, 60_000);

  afterAll(async () => {
    if (jwksServer) await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
    await db?.end();
  });

  // The subject lands in `sub` (the issuer's default subject_claim) and is matched against
  // app."user".email, so a realistic token carries email_verified alongside it — the route
  // requires it, because the address is the whole binding to a local user and an IdP that has
  // not verified it has not established that this token's holder controls it.
  function signSubjectJwt(
    subject: string,
    opts: {
      issuer?: string;
      audience?: string;
      emailVerified?: boolean;
      expires?: string | null;
    } = {},
  ) {
    const {
      issuer = trustedIssuer.issuer,
      audience = trustedIssuer.audience,
      emailVerified = true,
      expires = "1h",
    } = opts;
    let jwt = new SignJWT({ email_verified: emailVerified })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(subject);
    if (expires !== null) jwt = jwt.setExpirationTime(expires);
    return jwt.sign(keyPair.privateKey);
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

  async function delegatedExchange(
    clientId: string,
    secret: string,
    jwt: string,
    scope = "env:dev",
  ) {
    return exchange({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: jwt,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      client_id: clientId,
      client_secret: secret,
      scope,
    });
  }

  describe("valid exchange", () => {
    it("yields a token bound to the subject's grants", async () => {
      const app = getAppPool();
      const clientId = await registerClient("TE Valid");
      await upsertClientPolicy(app, clientId, "TE Valid", ["env:dev"]);
      await app.query(
        `update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`,
        [trustedIssuer.id, clientId],
      );
      const { secret } = await createClientSecret(
        app,
        clientId,
        "default",
        new Date(Date.now() + 86_400_000),
        "test",
      );

      const jwt = await signSubjectJwt("mia@harbor.demo");
      const res = await delegatedExchange(clientId, secret, jwt);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.access_token).toBeDefined();
      expect(body.token_type).toBe("Bearer");
      expect(body.scope).toContain("env:dev");
      // This endpoint issues no refresh token — both grant types it serves hold a credential they
      // can present again (RFC 6749 §4.4.3). One used to be minted, stored already expired, and
      // never returned: an unusable secret per exchange.
      expect(body.refresh_token).toBeUndefined();
    });

    it("narrows scope to the client's allowed_collections ceiling, never widens", async () => {
      const app = getAppPool();
      const clientId = await registerClient("TE Ceiling");
      await upsertClientPolicy(app, clientId, "TE Ceiling", ["env:dev"]);
      await app.query(
        `update app.client_policies set mode='delegated', allowed_collections=$1, trusted_issuer_id=$2 where client_id=$3`,
        [["feedback"], trustedIssuer.id, clientId],
      );
      const { secret } = await createClientSecret(
        app,
        clientId,
        "default",
        new Date(Date.now() + 86_400_000),
        "test",
      );
      const jwt = await signSubjectJwt("mia@harbor.demo");

      const res = await delegatedExchange(clientId, secret, jwt);
      expect(res.status).toBe(200);

      // Bind the issued token to a REST context and confirm the ceiling actually applies —
      // a request against a collection outside the ceiling refuses no_grant, never "documents".
      const { access_token } = await res.json();
      const { deriveRestContext } = await import("../lib/rest-context");
      const ctx = await deriveRestContext(
        new Request("http://localhost:8722/v1/collections", {
          headers: { authorization: `Bearer ${access_token}` },
        }),
      );
      expect(ctx?.allowedCollections).toEqual(["feedback"]);
    });
  });

  it("an unregistered issuer is refused", async () => {
    const app = getAppPool();
    const clientId = await registerClient("TE No Issuer");
    await upsertClientPolicy(app, clientId, "TE No Issuer", ["env:dev"]);
    // mode='delegated' but trusted_issuer_id left null — never registered.
    await app.query(`update app.client_policies set mode='delegated' where client_id=$1`, [
      clientId,
    ]);
    const { secret } = await createClientSecret(
      app,
      clientId,
      "default",
      new Date(Date.now() + 86_400_000),
      "test",
    );
    const jwt = await signSubjectJwt("mia@harbor.demo");

    const res = await delegatedExchange(clientId, secret, jwt);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("a cross-org subject is refused", async () => {
    const app = getAppPool();
    const clientId = await registerClient("TE Cross Org");
    await upsertClientPolicy(app, clientId, "TE Cross Org", ["env:dev"]);
    await app.query(
      `update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`,
      [trustedIssuer.id, clientId],
    );
    const { secret } = await createClientSecret(
      app,
      clientId,
      "default",
      new Date(Date.now() + 86_400_000),
      "test",
    );

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
    await app.query(
      `update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`,
      [trustedIssuer.id, clientId],
    );
    const { secret } = await createClientSecret(
      app,
      clientId,
      "default",
      new Date(Date.now() + 86_400_000),
      "test",
    );

    const res = await exchange({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: secret,
      scope: "env:dev",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unauthorized_client");
  });

  it("a headless client cannot use token-exchange", async () => {
    const app = getAppPool();
    const clientId = await registerClient("TE Headless Wrong Grant");
    await upsertClientPolicy(app, clientId, "TE Headless Wrong Grant", ["env:dev"]);
    await app.query(
      `update app.client_policies set mode='headless', robot_user_id='marcus' where client_id=$1`,
      [clientId],
    );
    const { secret } = await createClientSecret(
      app,
      clientId,
      "default",
      new Date(Date.now() + 86_400_000),
      "test",
    );
    const jwt = await signSubjectJwt("marcus");

    const res = await delegatedExchange(clientId, secret, jwt);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unauthorized_client");
  });

  // Every attempt used to be free, and each one that gets past the format check runs an scrypt
  // derivation. The cap is per client_id so one caller cannot lock the others out.
  describe("rate limiting", () => {
    it("answers 429 with Retry-After once a client exceeds the window, and not before", async () => {
      const { resetRateLimits } = await import("../lib/rate-limit");
      resetRateLimits();

      const app = getAppPool();
      const clientId = await registerClient("TE RateLimit");
      await upsertClientPolicy(app, clientId, "TE RateLimit", ["env:dev"]);
      await app.query(
        `update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`,
        [trustedIssuer.id, clientId],
      );
      const { secret } = await createClientSecret(
        app,
        clientId,
        "default",
        new Date(Date.now() + 86_400_000),
        "test",
      );

      // The limit is 30/minute. Legitimate use is far below it, so the first exchange must pass.
      const first = await delegatedExchange(
        clientId,
        secret,
        await signSubjectJwt("mia@harbor.demo"),
      );
      expect(first.status).toBe(200);

      let limited: Response | null = null;
      for (let i = 0; i < 40 && !limited; i++) {
        const res = await delegatedExchange(
          clientId,
          secret,
          await signSubjectJwt("mia@harbor.demo"),
        );
        if (res.status === 429) limited = res;
      }
      expect(limited).not.toBeNull();
      expect(await limited!.json()).toEqual({ error: "slow_down" });
      expect(Number(limited!.headers.get("retry-after"))).toBeGreaterThan(0);

      resetRateLimits();
    });

    it("does not let one throttled client block another", async () => {
      const { resetRateLimits, rateLimit } = await import("../lib/rate-limit");
      resetRateLimits();
      const app = getAppPool();

      // Burn a different client's window directly, then confirm ours still works.
      for (let i = 0; i < 60; i++)
        rateLimit("v1-token:someone-else", { max: 30, windowMs: 60_000 });

      const clientId = await registerClient("TE NotBlocked");
      await upsertClientPolicy(app, clientId, "TE NotBlocked", ["env:dev"]);
      await app.query(
        `update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`,
        [trustedIssuer.id, clientId],
      );
      const { secret } = await createClientSecret(
        app,
        clientId,
        "default",
        new Date(Date.now() + 86_400_000),
        "test",
      );

      const res = await delegatedExchange(
        clientId,
        secret,
        await signSubjectJwt("mia@harbor.demo"),
      );
      expect(res.status).toBe(200);
      resetRateLimits();
    });
  });

  // A token has to say which environment it reaches. This endpoint stored an empty scope string
  // when the caller named no env scope, and every reader then supplied dev as a default — so the
  // env a token reached was a property of whoever read it rather than of the token.
  describe("issued scope", () => {
    it("records the resolved env scope even when the caller requested none", async () => {
      const app = getAppPool();
      const clientId = await registerClient("TE NoScopeRequested");
      await upsertClientPolicy(app, clientId, "TE NoScopeRequested", ["env:dev"]);
      await app.query(
        `update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`,
        [trustedIssuer.id, clientId],
      );
      const { secret } = await createClientSecret(
        app,
        clientId,
        "default",
        new Date(Date.now() + 86_400_000),
        "test",
      );

      const res = await exchange({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: await signSubjectJwt("mia@harbor.demo"),
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        client_id: clientId,
        client_secret: secret,
        // no `scope` at all
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.scope).toBe("env:dev");

      // and the stored row carries it too, not an empty string
      const row = await app.query(
        `select scopes from app."oauthAccessToken" where "accessToken"=$1`,
        [body.access_token],
      );
      expect(row.rows[0].scopes).toBe("env:dev");
    });

    it("refuses to mint a token for a client whose policy allows no environment", async () => {
      const app = getAppPool();
      const clientId = await registerClient("TE NoEnvAllowed");
      await upsertClientPolicy(app, clientId, "TE NoEnvAllowed", []);
      await app.query(
        `update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`,
        [trustedIssuer.id, clientId],
      );
      const { secret } = await createClientSecret(
        app,
        clientId,
        "default",
        new Date(Date.now() + 86_400_000),
        "test",
      );

      const res = await delegatedExchange(
        clientId,
        secret,
        await signSubjectJwt("mia@harbor.demo"),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_scope");
    });
  });

  // The subject token is the whole identity claim in this flow: whatever it says, the exchange
  // acts as that local user. These are the properties of it that were not being checked.
  describe("subject token verification", () => {
    async function delegatedClient(name: string) {
      const app = getAppPool();
      const clientId = await registerClient(name);
      await upsertClientPolicy(app, clientId, name, ["env:dev"]);
      await app.query(
        `update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`,
        [trustedIssuer.id, clientId],
      );
      const { secret } = await createClientSecret(
        app,
        clientId,
        "default",
        new Date(Date.now() + 86_400_000),
        "test",
      );
      return { clientId, secret };
    }

    // An IdP that has not verified the address has not established that the token's holder
    // controls it, and the address is the only thing binding this token to a local user. An IdP
    // permitting signup with an unverified corporate address would otherwise hand out that
    // user's grants to whoever claimed it.
    it("refuses a subject token whose email is not verified", async () => {
      const { clientId, secret } = await delegatedClient("TE Unverified");
      const jwt = await signSubjectJwt("mia@harbor.demo", { emailVerified: false });
      const res = await delegatedExchange(clientId, secret, jwt);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_grant");
    });

    it("refuses a subject token with no email_verified claim at all", async () => {
      const { clientId, secret } = await delegatedClient("TE NoVerifiedClaim");
      // Sign without the claim rather than with it set false — absent and false must agree.
      const jwt = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
        .setIssuer(trustedIssuer.issuer)
        .setAudience(trustedIssuer.audience)
        .setSubject("mia@harbor.demo")
        .setExpirationTime("1h")
        .sign(keyPair.privateKey);
      const res = await delegatedExchange(clientId, secret, jwt);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_grant");
    });

    // jose validates only the claims a token actually carries, so a subject token with no `exp`
    // verified forever and a single captured token stayed usable indefinitely.
    it("refuses a subject token with no exp", async () => {
      const { clientId, secret } = await delegatedClient("TE NoExp");
      const jwt = await signSubjectJwt("mia@harbor.demo", { expires: null });
      const res = await delegatedExchange(clientId, secret, jwt);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_grant");
    });

    it("refuses an expired subject token", async () => {
      const { clientId, secret } = await delegatedClient("TE Expired");
      const jwt = await signSubjectJwt("mia@harbor.demo", { expires: "-1h" });
      const res = await delegatedExchange(clientId, secret, jwt);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_grant");
    });

    // The subject is matched against app."user".email, so a claim carrying something that is not
    // an address can never be a legitimate identity here. Refusing says so; the previous silent
    // no-match looked identical to "no such user".
    it("refuses a subject that is not an email address", async () => {
      const { clientId, secret } = await delegatedClient("TE OpaqueSub");
      const jwt = await signSubjectJwt("8f14e45f-ea6a-4c1f-9d0b-2b1c3d4e5f60");
      const res = await delegatedExchange(clientId, secret, jwt);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_grant");
    });

    it("fetches the issuer's JWKS once across repeated exchanges, not once per request", async () => {
      const { clientId, secret } = await delegatedClient("TE JwksCache");
      // Warm the cache first so the count below cannot include a cold fetch.
      await delegatedExchange(clientId, secret, await signSubjectJwt("mia@harbor.demo"));
      const before = jwksFetches;
      for (let i = 0; i < 3; i++) {
        const res = await delegatedExchange(
          clientId,
          secret,
          await signSubjectJwt("mia@harbor.demo"),
        );
        expect(res.status).toBe(200);
      }
      expect(jwksFetches).toBe(before);
    });
  });

  it("a revoked key fails the very next request, no expiry wait", async () => {
    const app = getAppPool();
    const clientId = await registerClient("TE Revoke");
    await upsertClientPolicy(app, clientId, "TE Revoke", ["env:dev"]);
    await app.query(
      `update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`,
      [trustedIssuer.id, clientId],
    );
    const { id: secretId, secret } = await createClientSecret(
      app,
      clientId,
      "default",
      new Date(Date.now() + 86_400_000),
      "test",
    );
    const jwt = await signSubjectJwt("mia@harbor.demo");

    const res1 = await delegatedExchange(clientId, secret, jwt);
    expect(res1.status).toBe(200);

    // revokeClientSecret is scoped by client and org, so no caller can revoke across tenants with
    // a secret id alone. Its return value says whether a row matched — asserted here, because a
    // revoke that silently matched nothing would leave the key live and make the 401 below the
    // only symptom of it.
    expect(await revokeClientSecret(app, secretId, clientId, "default")).toBe(true);
    const res2 = await delegatedExchange(clientId, secret, jwt);
    expect(res2.status).toBe(401);
  });

  describe("env-scope parity with the OAuth flow (same rules as apps/web/test/oauth-scope.integration.test.ts)", () => {
    it("rule 1: dev-only client requesting env:live gets only env:dev", async () => {
      const app = getAppPool();
      const clientId = await registerClient("TE Rule1");
      await upsertClientPolicy(app, clientId, "TE Rule1", ["env:dev"]);
      await app.query(
        `update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`,
        [trustedIssuer.id, clientId],
      );
      const { secret } = await createClientSecret(
        app,
        clientId,
        "default",
        new Date(Date.now() + 86_400_000),
        "test",
      );
      const jwt = await signSubjectJwt("mia@harbor.demo");

      const res = await exchange({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: jwt,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        client_id: clientId,
        client_secret: secret,
        scope: "env:dev env:live",
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
      await app.query(
        `update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`,
        [trustedIssuer.id, clientId],
      );
      const { secret } = await createClientSecret(
        app,
        clientId,
        "default",
        new Date(Date.now() + 86_400_000),
        "test",
      );
      const jwt = await signSubjectJwt("mia@harbor.demo");

      const res = await exchange({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: jwt,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        client_id: clientId,
        client_secret: secret,
        scope: "env:live",
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
        userId: "mia",
        collection: "feedback",
        orgId: "default",
        env: "live",
        purposeLabel: "test",
        allowedFields: ["id"],
      });
      await approveGrant(app, db.cfg, grantId, "marcus", {
        verbs: ["read"],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });

      const clientId = await registerClient("TE Rule2b");
      await upsertClientPolicy(app, clientId, "TE Rule2b", ["env:dev", "env:live"]);
      await app.query(
        `update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`,
        [trustedIssuer.id, clientId],
      );
      // Minted `live`: the key's own prefix is a ceiling, so a dev-prefixed key would be capped at
      // env:dev here however eligible the user is — which is the next test.
      const { secret } = await createClientSecret(
        app,
        clientId,
        "default",
        new Date(Date.now() + 86_400_000),
        "test",
        "live",
      );
      const jwt = await signSubjectJwt("mia@harbor.demo");

      const res = await exchange({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: jwt,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        client_id: clientId,
        client_secret: secret,
        scope: "env:live",
      });
      expect(res.status).toBe(200);
      expect((await res.json()).scope).toContain("env:live");
    });

    // The ceiling, end to end and against the most permissive everything else: policy allows both
    // envs, the user holds the approved live grant seeded by the test above, and the request asks
    // for live. The only thing standing in the way is the four characters in the key's prefix.
    it("a whd_dev_ key is capped at env:dev even when policy and user both allow live", async () => {
      const app = getAppPool();
      const clientId = await registerClient("TE KeyPrefix");
      await upsertClientPolicy(app, clientId, "TE KeyPrefix", ["env:dev", "env:live"]);
      await app.query(
        `update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`,
        [trustedIssuer.id, clientId],
      );
      const { secret } = await createClientSecret(
        app,
        clientId,
        "default",
        new Date(Date.now() + 86_400_000),
        "test",
        "dev",
      );
      expect(secret).toMatch(/^whd_dev_/);
      const jwt = await signSubjectJwt("mia@harbor.demo");

      for (const scope of ["env:live", "env:dev env:live", "env:live env:dev", ""]) {
        const res = await exchange({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: jwt,
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          client_id: clientId,
          client_secret: secret,
          scope,
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.scope).toBe("env:dev");
      }
    });

    it("an env:dev-only key cannot obtain env:live by any request shape", async () => {
      const app = getAppPool();
      const clientId = await registerClient("TE Parity");
      await upsertClientPolicy(app, clientId, "TE Parity", ["env:dev"]);
      await app.query(
        `update app.client_policies set mode='delegated', trusted_issuer_id=$1 where client_id=$2`,
        [trustedIssuer.id, clientId],
      );
      const { secret } = await createClientSecret(
        app,
        clientId,
        "default",
        new Date(Date.now() + 86_400_000),
        "test",
      );
      const jwt = await signSubjectJwt("mia@harbor.demo");

      for (const scope of ["env:live", "env:dev env:live", "ENV:LIVE", "env:live env:dev"]) {
        const res = await exchange({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: jwt,
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          client_id: clientId,
          client_secret: secret,
          scope,
        });
        if (res.status === 200) expect((await res.json()).scope).not.toContain("env:live");
      }
    });
  });
});
