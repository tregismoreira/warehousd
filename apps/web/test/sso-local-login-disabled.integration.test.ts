import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";

// Set LOCAL_LOGIN_DISABLED before importing auth (which reads it at module load).
process.env.WAREHOUSD_DISABLE_LOCAL_LOGIN = "true";

import { setupWebDb } from "./helpers/web-db";
import { ssoSignIn } from "./helpers/sso";
import { startFakeIdp } from "./helpers/fake-idp";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let fakeIdp: Awaited<ReturnType<typeof startFakeIdp>>;
let appPool: Pool;

beforeAll(async () => {
  fakeIdp = await startFakeIdp({ users: [] });
  // Skip seeding personas since local login is disabled and auth.api.signUpEmail won't work
  db = await setupWebDb("sso-local-login-disabled", { seedPersonas: false });
  appPool = getAppPool();

  // Create an admin user directly in the DB so we can register the SSO provider
  const adminId = crypto.randomUUID();
  await appPool.query(
    `insert into app."user" (id, email, name, role, "emailVerified") values ($1, $2, $3, $4, $5)`,
    [adminId, "admin@test.demo", "Admin Temp", "admin", true],
  );

  // Create a session for the admin user manually
  const sessionId = crypto.randomUUID();
  const sessionToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await appPool.query(
    `insert into app."session" (id, token, "userId", "expiresAt", "createdAt", "updatedAt") values ($1, $2, $3, $4, $5, $6)`,
    [sessionId, sessionToken, adminId, expiresAt, new Date(), new Date()],
  );

  // Register the SSO provider directly in the database (bypassing the admin-only HTTP route)
  await appPool.query(
    `insert into app."ssoProvider" (id, "providerId", "userId", issuer, domain, "oidcConfig") values ($1, $2, $3, $4, $5, $6)`,
    [
      crypto.randomUUID(),
      "test-oidc",
      adminId,
      fakeIdp.issuer,
      "test.demo",
      JSON.stringify({
        clientId: "test-client",
        clientSecret: "test-secret",
        discoveryEndpoint: `${fakeIdp.issuer}/.well-known/openid-configuration`,
      }),
    ],
  );
}, 60_000);

afterAll(async () => {
  await db?.end();
  await fakeIdp?.close();
});

describe("Local login disabled", () => {
  it("POST /api/auth/sign-in/email with valid demo credentials → non-2xx", async () => {
    const res = await db.auth.handler(
      new Request("http://localhost:8722/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "ana@harbor.demo", password: "demo" }),
      }),
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("SSO sign-in still succeeds and JIT-provisions a member", async () => {
    fakeIdp.setNextUser({
      sub: "newssoaccount@test.demo",
      email: "newssoaccount@test.demo",
      email_verified: true,
      name: "New SSO Account",
    });

    await ssoSignIn(db.auth, "test-oidc", "/");

    // Query the database for the new user
    const result = await appPool.query(
      `select id, email, role from app."user" where email = $1`,
      ["newssoaccount@test.demo"],
    );

    expect(result.rows).toHaveLength(1);
    const user = result.rows[0];
    expect(user.email).toBe("newssoaccount@test.demo");
    expect(user.role).toBe("member");
  });
});
