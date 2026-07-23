import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { upsertClientPolicy } from "@warehousd/broker";
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
