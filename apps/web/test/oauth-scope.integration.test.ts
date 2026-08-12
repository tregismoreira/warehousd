import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { authorizeAndGetCode, pkcePair } from "./helpers/oauth";
import {
  upsertClientPolicy,
  approveGrant,
  requestGrant,
  loadConfig,
  setMember,
} from "@warehousd/broker";

// approveGrant validates verbs against the collection's config, and these fixtures grant over
// harbor collections — so that is the config the rules have to be checked against.
const harborCfg = loadConfig(new URL("../../../examples/harbor", import.meta.url).pathname);

import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let miaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("oauthscope");
  const app = getAppPool();
  await app.query(
    `insert into app.workspaces (id, name) values ('w2', 'W2') on conflict do nothing`,
  );
  // Mia is a member of 'default' (bootstrap) only — 'w2' is a non-membership for rule 2j.
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
}, 60_000);
afterAll(async () => {
  await db?.end();
});

// Exchanges an authorization code for a token, returning the granted scope — the scope
// intersection is invisible at the authorize step (no consent screen echoes it back and
// Better Auth doesn't put it in the redirect URL); the token response is the only place it's
// observable.
async function exchangeCodeForScope(
  clientId: string,
  clientSecret: string,
  code: string,
  verifier: string,
) {
  const tokenRes = await db.auth.api.mcpOAuthToken({
    body: {
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:9999/callback",
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: verifier,
    },
    asResponse: true,
  } as any);
  const body = await tokenRes.json();
  return body.scope as string;
}

describe("rule 1: dev-only client requesting env:live gets only env:dev", () => {
  it("rewrites the authorize query's scope before the code is ever issued", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Dev Only Client" },
      asResponse: true,
    } as any);
    const { client_id, client_secret } = await reg.json();
    // Force the dev-only policy (DCR default is {env:dev,env:live} — Task 8; here we
    // simulate a manually-created client's policy directly, since manual creation is Task 9).
    const app = getAppPool();
    await upsertClientPolicy(app, client_id, "Dev Only Client", ["env:dev"]);

    const { verifier, challenge } = pkcePair();
    const { code } = await authorizeAndGetCode(db.auth, {
      clientId: client_id,
      scope: "env:live openid",
      cookie: miaCookie,
      challenge,
    });
    expect(code).toBeTruthy();
    const scope = await exchangeCodeForScope(client_id, client_secret, code!, verifier);
    expect(scope).not.toContain("env:live");
  });
});

describe("rule 2: env:live requires an approved, unexpired live grant", () => {
  it("live-allowed client + user with NO approved live grant → env:live silently dropped", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: {
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "Live Allowed Client",
      },
      asResponse: true,
    } as any);
    const { client_id, client_secret } = await reg.json();
    const app = getAppPool();
    await upsertClientPolicy(app, client_id, "Live Allowed Client", ["env:dev", "env:live"]);
    // mia has no approved live grant in the seed data used by setupWebDb's personas.

    const { verifier, challenge } = pkcePair();
    const { code } = await authorizeAndGetCode(db.auth, {
      clientId: client_id,
      scope: "env:live openid",
      cookie: miaCookie,
      challenge,
    });
    expect(code).toBeTruthy();
    const scope = await exchangeCodeForScope(client_id, client_secret, code!, verifier);
    expect(scope).not.toContain("env:live");
  });

  it("live-allowed client + user WITH an approved, unexpired live grant → env:live survives", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: {
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "Live Allowed Client 2",
      },
      asResponse: true,
    } as any);
    const { client_id, client_secret } = await reg.json();
    const app = getAppPool();
    await upsertClientPolicy(app, client_id, "Live Allowed Client 2", ["env:dev", "env:live"]);
    const grantId = await requestGrant(app, {
      userId: "mia",
      collection: "people",
      workspaceId: "default",
      env: "live",
      purposeLabel: "test",
      allowedFields: ["id"],
    });
    await approveGrant(app, harborCfg, grantId, "marcus", {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const { verifier, challenge } = pkcePair();
    const { code } = await authorizeAndGetCode(db.auth, {
      clientId: client_id,
      scope: "env:live",
      cookie: miaCookie,
      challenge,
    });
    expect(code).toBeTruthy();
    const scope = await exchangeCodeForScope(client_id, client_secret, code!, verifier);
    expect(scope).toContain("env:live");
  });

  it("live-allowed client + user WITH an approved live grant with NULL expires_at → env:live survives", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: {
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "Live Allowed Client 3",
      },
      asResponse: true,
    } as any);
    const { client_id, client_secret } = await reg.json();
    const app = getAppPool();
    await upsertClientPolicy(app, client_id, "Live Allowed Client 3", ["env:dev", "env:live"]);
    const grantId = await requestGrant(app, {
      userId: "mia",
      collection: "col_r2_nullexp",
      workspaceId: "default",
      env: "live",
      purposeLabel: "permanent",
      allowedFields: ["id"],
    });
    // Approve with no expiry — expires_at will be NULL in the database
    await approveGrant(app, harborCfg, grantId, "marcus", {});

    const { verifier, challenge } = pkcePair();
    const { code } = await authorizeAndGetCode(db.auth, {
      clientId: client_id,
      scope: "env:live",
      cookie: miaCookie,
      challenge,
    });
    expect(code).toBeTruthy();
    const scope = await exchangeCodeForScope(client_id, client_secret, code!, verifier);
    expect(scope).toContain("env:live");
  });
});

describe("rule 3: both env:dev and env:live survive → redirected to the env picker", () => {
  it("redirects to /oauth/env-picker, carrying the surviving scopes", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Both Envs Client" },
      asResponse: true,
    } as any);
    const { client_id } = await reg.json();
    const app = getAppPool();
    await upsertClientPolicy(app, client_id, "Both Envs Client", ["env:dev", "env:live"]);
    const grantId = await requestGrant(app, {
      userId: "mia",
      collection: "col_r3_1",
      workspaceId: "default",
      env: "live",
      purposeLabel: "t",
      allowedFields: ["id"],
    });
    await approveGrant(app, harborCfg, grantId, "marcus", {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const { challenge } = pkcePair();
    const { res } = await authorizeAndGetCode(db.auth, {
      clientId: client_id,
      scope: "env:dev env:live",
      cookie: miaCookie,
      challenge,
    });
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain("/oauth/env-picker");
  });

  it("resubmitting with wh_env=live collapses to exactly one env scope", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: {
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "Both Envs Client 2",
      },
      asResponse: true,
    } as any);
    const { client_id, client_secret } = await reg.json();
    const app = getAppPool();
    await upsertClientPolicy(app, client_id, "Both Envs Client 2", ["env:dev", "env:live"]);
    const grantId = await requestGrant(app, {
      userId: "mia",
      collection: "col_r3_2",
      workspaceId: "default",
      env: "live",
      purposeLabel: "t",
      allowedFields: ["id"],
    });
    await approveGrant(app, harborCfg, grantId, "marcus", {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const { verifier, challenge } = pkcePair();
    const { code } = await authorizeAndGetCode(db.auth, {
      clientId: client_id,
      scope: "env:dev env:live",
      cookie: miaCookie,
      challenge,
      extraParams: { wh_env: "live" },
    });
    expect(code).toBeTruthy();
    const scope = await exchangeCodeForScope(client_id, client_secret, code!, verifier);
    expect(scope).toContain("env:live");
    expect(scope).not.toContain("env:dev");
  });

  it("a tampered wh_env value outside {dev,live} is ignored, re-triggering the picker redirect", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: {
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "Both Envs Client 3",
      },
      asResponse: true,
    } as any);
    const { client_id } = await reg.json();
    const app = getAppPool();
    await upsertClientPolicy(app, client_id, "Both Envs Client 3", ["env:dev", "env:live"]);
    const grantId = await requestGrant(app, {
      userId: "mia",
      collection: "col_r3_3",
      workspaceId: "default",
      env: "live",
      purposeLabel: "t",
      allowedFields: ["id"],
    });
    await approveGrant(app, harborCfg, grantId, "marcus", {
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const { challenge } = pkcePair();
    const { res } = await authorizeAndGetCode(db.auth, {
      clientId: client_id,
      scope: "env:dev env:live",
      cookie: miaCookie,
      challenge,
      extraParams: { wh_env: "env:live env:dev" }, // attempted injection
    });
    expect(res.headers.get("location")).toContain("/oauth/env-picker");
  });
});

// A `workspace:<id>` scope is always dropped at this boundary — not because of a membership
// check (there is none here), but because Better Auth's mcp plugin validates the authorize
// request's `scope` against a fixed, pre-registered enum (opts.scopes, built once from
// oidcConfig.scopes — see the comment at the drop site in lib/oauth.ts). A per-workspace scope
// can never be a member of that enum, since workspace ids are created at runtime; letting one
// survive would have Better Auth's own validation reject the whole authorize request instead of
// just the one scope. The MCP/OAuth boundary resolves the workspace per-request instead, via
// resolveWorkspace's no-scope-requested fallback — covered by workspace-resolution.test.ts.
describe("workspace scope (§2.4): never survives MCP authorize — see lib/oauth.ts", () => {
  it("a requested workspace: scope is dropped from the granted set, not returned", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "WS Scope Client" },
      asResponse: true,
    } as any);
    const { client_id, client_secret } = await reg.json();
    const app = getAppPool();
    await upsertClientPolicy(app, client_id, "WS Scope Client", ["env:dev"]);
    // Membership makes no difference to this boundary's behaviour — asserted with mia IS a
    // member of w2, so a naive membership-based implementation would wrongly let it through.
    await setMember(app, { workspaceId: "w2", userId: "mia", role: "member" });

    const { verifier, challenge } = pkcePair();
    const { code } = await authorizeAndGetCode(db.auth, {
      clientId: client_id,
      scope: "env:dev workspace:w2",
      cookie: miaCookie,
      challenge,
    });
    expect(code).toBeTruthy();
    const scope = await exchangeCodeForScope(client_id, client_secret, code!, verifier);
    expect(scope).not.toContain("workspace:w2");
    expect(scope).toContain("env:dev");
  });
});
