import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { upsertClientPolicy, approveGrant, requestGrant } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let miaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("oauthscope");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

describe("rule 1: dev-only client requesting env:live gets only env:dev", () => {
  it("rewrites the authorize query's scope before the client is ever shown a consent screen", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Dev Only Client" },
      asResponse: true,
    } as any);
    const { client_id } = await reg.json();
    // Force the dev-only policy (DCR default is {env:dev,env:live} — Task 8; here we
    // simulate a manually-created client's policy directly, since manual creation is Task 9).
    const app = getAppPool();
    await upsertClientPolicy(app, client_id, "Dev Only Client", ["env:dev"]);

    const res = await db.auth.api.mcpOAuthAuthorize({
      query: {
        client_id: client_id,
        response_type: "code",
        redirect_uri: "http://localhost:9999/callback",
        scope: "env:live openid",
        code_challenge: "test-challenge-000000000000000000000000000",
        code_challenge_method: "S256",
      },
      headers: { cookie: miaCookie } as any,
      asResponse: true,
    } as any);

    // Either a redirect to the consent page or an error — in both cases env:live must never
    // appear in the location/body. Assert on whichever the response actually is.
    const location = res.headers.get("location") ?? "";
    const bodyText = await res.text().catch(() => "");
    expect(location + bodyText).not.toContain("env:live");
  });
});

describe("rule 2: env:live requires an approved, unexpired live grant", () => {
  it("live-allowed client + user with NO approved live grant → env:live silently dropped", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Live Allowed Client" },
      asResponse: true,
    } as any);
    const { client_id } = await reg.json();
    const app = getAppPool();
    await upsertClientPolicy(app, client_id, "Live Allowed Client", ["env:dev", "env:live"]);
    // mia has no approved live grant in the seed data used by setupWebDb's personas.

    const res = await db.auth.api.mcpOAuthAuthorize({
      query: {
        client_id: client_id, response_type: "code",
        redirect_uri: "http://localhost:9999/callback", scope: "env:live openid",
        code_challenge: "test-challenge-000000000000000000000000000",
        code_challenge_method: "S256",
      },
      headers: { cookie: miaCookie } as any,
      asResponse: true,
    } as any);
    const location = res.headers.get("location") ?? "";
    const bodyText = await res.text().catch(() => "");
    expect(location + bodyText).not.toContain("env:live");
  });

  it("live-allowed client + user WITH an approved, unexpired live grant → env:live survives", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Live Allowed Client 2" },
      asResponse: true,
    } as any);
    const { client_id } = await reg.json();
    const app = getAppPool();
    await upsertClientPolicy(app, client_id, "Live Allowed Client 2", ["env:dev", "env:live"]);
    const grantId = await requestGrant(app, {
      userId: "mia", collection: "people", env: "live",
      purposeLabel: "test", allowedFields: ["id"],
    });
    await approveGrant(app, grantId, "marcus", { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });

    const res = await db.auth.api.mcpOAuthAuthorize({
      query: {
        client_id: client_id, response_type: "code",
        redirect_uri: "http://localhost:9999/callback", scope: "env:live openid",
        code_challenge: "test-challenge-000000000000000000000000000",
        code_challenge_method: "S256",
      },
      headers: { cookie: miaCookie } as any,
      asResponse: true,
    } as any);
    const location = res.headers.get("location") ?? "";
    const bodyText = await res.text().catch(() => "");
    expect(location + bodyText).toContain("env:live");
  });
});
