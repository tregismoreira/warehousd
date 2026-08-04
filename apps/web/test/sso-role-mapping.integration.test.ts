import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { setupWebDb, signIn } from "./helpers/web-db";
import { ssoSignIn } from "./helpers/sso";
import { startFakeIdp } from "./helpers/fake-idp";
import { getAppPool } from "../app/lib/broker";

// The group→role map, end to end: an IdP asserting a group, through better-auth's provisioning
// hook, to the row the console reads a role from. roleForSsoUser is unit-tested in
// sso-role-mapping.test.ts; what this file proves is the wiring — that the claim survives the
// journey, and that the config the running server holds is the one consulted.
//
// The fixture's map lives in apps/web/test/fixtures/sso-roles/warehousd.yml: wh-admins → admin,
// wh-managers → manager, nothing else mapped.
const fixtureDir = new URL("./fixtures/sso-roles", import.meta.url).pathname;

let db: Awaited<ReturnType<typeof setupWebDb>>;
let fakeIdp: Awaited<ReturnType<typeof startFakeIdp>>;
let appPool: Pool;

beforeAll(async () => {
  fakeIdp = await startFakeIdp({ users: [] });
  db = await setupWebDb("sso-roles", { projectDir: fixtureDir });
  appPool = getAppPool();

  const anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");
  const res = await db.auth.handler(
    new Request("http://localhost:8722/api/auth/sso/register", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: anaCookie },
      body: JSON.stringify({
        providerId: "test-oidc",
        issuer: fakeIdp.issuer,
        domain: "harbor.demo",
        oidcConfig: {
          clientId: "test-client",
          clientSecret: "test-secret",
          discoveryEndpoint: `${fakeIdp.issuer}/.well-known/openid-configuration`,
          // Without this the claim never reaches the hook: better-auth hands provisionUser a
          // MAPPED user-info object (id/email/name/image plus extraFields), not the raw claim
          // set. The config names the claim; the registration is what carries it across.
          //
          // `id`, `email` and `name` are required once `mapping` is present at all, so the
          // defaults have to be restated — omitting them is a 400, not an inherited default.
          mapping: {
            id: "sub",
            email: "email",
            emailVerified: "email_verified",
            name: "name",
            extraFields: { groups: "groups" },
          },
        },
      }),
    }),
  );
  if (!res.ok) throw new Error(`Failed to register SSO provider: ${res.status}`);
}, 60_000);

afterAll(async () => {
  await db?.end();
  await fakeIdp?.close();
});

async function signInAs(email: string, groups?: unknown): Promise<string> {
  fakeIdp.setNextUser({
    sub: email,
    email,
    email_verified: true,
    name: email,
    ...(groups !== undefined ? { groups } : {}),
  });
  await ssoSignIn(db.auth, "test-oidc", "/");
  const r = await appPool.query(`select role from app."user" where email = $1`, [email]);
  expect(r.rows).toHaveLength(1);
  return r.rows[0].role as string;
}

describe("SSO JIT provisioning takes its role from the IdP's groups", () => {
  it("provisions a manager for a user in the mapped managers group", async () => {
    expect(await signInAs("groupmanager@harbor.demo", ["wh-managers"])).toBe("manager");
  });

  it("provisions an admin for the mapped admins group", async () => {
    expect(await signInAs("groupadmin@harbor.demo", ["wh-admins"])).toBe("admin");
  });

  it("takes the highest role when the user is in several mapped groups", async () => {
    expect(await signInAs("groupboth@harbor.demo", ["wh-managers", "wh-admins"])).toBe("admin");
  });

  it("leaves a user in no mapped group a member", async () => {
    expect(await signInAs("groupnone@harbor.demo", ["hr", "printer-access"])).toBe("member");
  });

  it("leaves a user whose IdP sends no groups at all a member", async () => {
    expect(await signInAs("groupless@harbor.demo")).toBe("member");
  });

  // The mapping runs on registration only, so a promotion made in the console is not undone by
  // the next SSO login — the same property that stops an existing admin being demoted on link.
  it("does not re-apply on a later login", async () => {
    expect(await signInAs("grouplater@harbor.demo", ["hr"])).toBe("member");
    await appPool.query(`update app."user" set role='admin' where email=$1`, [
      "grouplater@harbor.demo",
    ]);
    expect(await signInAs("grouplater@harbor.demo", ["hr"])).toBe("admin");
  });
});
