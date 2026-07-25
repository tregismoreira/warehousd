import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb } from "./helpers/web-db";
import { getClientPolicy, ensureDevClient, getDevClient, DEV_CLIENT_NAME } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;

beforeAll(async () => {
  db = await setupWebDb("devclient");
}, 60_000);

afterAll(async () => {
  await db?.end();
});

describe("ensureDevClient", () => {
  it("called twice returns identical {clientId, clientSecret} and leaves exactly one row", async () => {
    const app = getAppPool();

    // First call
    const first = await ensureDevClient(app, null);
    expect(first.clientId).toBeTruthy();
    expect(first.clientSecret).toBeTruthy();

    // Verify exactly one row exists with that name
    const check1 = await app.query(
      `select count(*) as cnt from app."oauthApplication" where name=$1`,
      [DEV_CLIENT_NAME]
    );
    expect(parseInt(check1.rows[0].cnt)).toBe(1);

    // Second call
    const second = await ensureDevClient(app, null);
    expect(second.clientId).toBe(first.clientId);
    expect(second.clientSecret).toBe(first.clientSecret);

    // Still exactly one row
    const check2 = await app.query(
      `select count(*) as cnt from app."oauthApplication" where name=$1`,
      [DEV_CLIENT_NAME]
    );
    expect(parseInt(check2.rows[0].cnt)).toBe(1);
  });

  it("after ensureDevClient, getClientPolicy returns exactly [\"env:dev\"]", async () => {
    const app = getAppPool();

    const client = await ensureDevClient(app, null);
    const policy = await getClientPolicy(app, client.clientId);

    expect(policy.allowedScopes).toEqual(["env:dev"]);
  });

  it("getDevClient returns null if no dev client exists, then returns client after ensureDevClient", async () => {
    const app = getAppPool();

    // First, clean up any existing dev client (from other tests)
    await app.query(`delete from app."oauthApplication" where name=$1`, [DEV_CLIENT_NAME]);

    // Should be null
    const none = await getDevClient(app);
    expect(none).toBeNull();

    // Create one
    const created = await ensureDevClient(app, null);

    // Should return it now
    const found = await getDevClient(app);
    expect(found).toEqual({ clientId: created.clientId, clientSecret: created.clientSecret });
  });
});
