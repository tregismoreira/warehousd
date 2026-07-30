import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { authorizeAndGetCode, pkcePair } from "./helpers/oauth";
import {
  upsertClientPolicy,
  approveGrant,
  requestGrant,
  revokeGrant,
  setAllowedScopes,
  loadConfig,
} from "@warehousd/broker";

// approveGrant validates verbs against the collection's config, and these fixtures grant over
// harbor collections — so that is the config the rules have to be checked against.
const harborCfg = loadConfig(new URL("../../../examples/harbor", import.meta.url).pathname);

import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let miaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("oauthrefresh");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
}, 60_000);
afterAll(async () => {
  await db?.end();
});

// Drives a client all the way from DCR through authorize to get a real refresh_token,
// since /mcp/token's refresh path needs a genuine row in oauthAccessToken to correct.
async function issueTokenWithLiveScope(collectionSuffix: string = "") {
  const app = getAppPool();
  const reg = await db.auth.api.registerMcpClient({
    body: {
      redirect_uris: ["http://localhost:9999/callback"],
      client_name: `Refresh Test Client${collectionSuffix}`,
    },
    asResponse: true,
  } as any);
  const { client_id, client_secret } = await reg.json(); // snake_case — RFC 7591
  await upsertClientPolicy(app, client_id, `Refresh Test Client${collectionSuffix}`, [
    "env:dev",
    "env:live",
  ]);
  const grantId = await requestGrant(app, {
    userId: "mia",
    collection: `people${collectionSuffix}`,
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
    scope: "env:live offline_access",
    cookie: miaCookie,
    challenge,
  });

  const tokenRes = await db.auth.api.mcpOAuthToken({
    body: {
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:9999/callback",
      client_id: client_id,
      client_secret: client_secret,
      code_verifier: verifier,
    },
    asResponse: true,
  } as any);
  const tokenBody = await tokenRes.json();
  return { clientId: client_id, clientSecret: client_secret, ...tokenBody };
}

describe("rule 4: scope rules re-run on every refresh", () => {
  it("demotion takes effect on the next refresh", async () => {
    const { clientId, clientSecret, refresh_token } = await issueTokenWithLiveScope("1");
    const app = getAppPool();
    await setAllowedScopes(app, clientId, ["env:dev"], "ana"); // demote

    const res = await db.auth.api.mcpOAuthToken({
      body: {
        grant_type: "refresh_token",
        refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      },
      asResponse: true,
    } as any);
    const body = await res.json();
    expect(body.scope).not.toContain("env:live");
  });

  it("revoked live grant takes effect on the next refresh", async () => {
    const app = getAppPool();
    const { clientId, clientSecret, refresh_token } = await issueTokenWithLiveScope("2");

    // Revoke ALL approved live grants for mia to test revocation properly
    const allGrants = await app.query(
      `select id from app.grants where user_id='mia' and env='live' and status='approved'`,
    );
    for (const g of allGrants.rows) {
      await revokeGrant(app, g.id, "marcus");
    }

    const res = await db.auth.api.mcpOAuthToken({
      body: {
        grant_type: "refresh_token",
        refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      },
      asResponse: true,
    } as any);
    const body = await res.json();
    expect(body.scope).not.toContain("env:live");
  });
});
