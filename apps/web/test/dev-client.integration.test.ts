import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb } from "./helpers/web-db";
import {
  getClientPolicy, ensureDevClient, getDevClient, hashOauthClientSecret, DEV_CLIENT_NAME,
} from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;

beforeAll(async () => {
  db = await setupWebDb("devclient");
}, 60_000);

afterAll(async () => {
  await db?.end();
});

describe("ensureDevClient", () => {
  it("registers redirectUrls so the mcp/authorize flow accepts a stored session cookie", async () => {
    const app = getAppPool();

    const client = await ensureDevClient(app, null);

    const row = await app.query(
      `select "redirectUrls" from app."oauthApplication" where "clientId"=$1`,
      [client.clientId]
    );
    expect(row.rowCount).toBe(1);
    // Better Auth reads this as a comma-separated string, not JSON (mcp/authorize.mjs
    // does `redirectUrls.split(",")`), so it must be stored as plain text.
    expect(row.rows[0].redirectUrls.split(",")).toEqual(["http://localhost/callback"]);
  });

  it("called twice with the same secret is idempotent and leaves exactly one row", async () => {
    const app = getAppPool();
    // The caller supplies the secret — the CLI holds it in .warehousd/state.json, so the same
    // value arrives on every boot and the stored hash does not move.
    const secret = "fixed-dev-secret-for-idempotency";

    const first = await ensureDevClient(app, null, secret);
    expect(first.clientId).toBeTruthy();
    expect(first.clientSecret).toBe(secret);

    // Verify exactly one row exists with that name
    const check1 = await app.query(
      `select count(*) as cnt from app."oauthApplication" where name=$1`,
      [DEV_CLIENT_NAME]
    );
    expect(parseInt(check1.rows[0].cnt)).toBe(1);

    // Second call
    const second = await ensureDevClient(app, null, secret);
    expect(second.clientId).toBe(first.clientId);
    expect(second.clientSecret).toBe(secret);

    // Still exactly one row
    const check2 = await app.query(
      `select count(*) as cnt from app."oauthApplication" where name=$1`,
      [DEV_CLIENT_NAME]
    );
    expect(parseInt(check2.rows[0].cnt)).toBe(1);
  });

  // The column used to hold the plaintext, and getDevClient handed it back — so a database dump
  // was a working credential. Better Auth verifies this column with
  // base64url(sha256(presented)), so that is what has to be in it.
  it("stores only a hash of the secret, never the plaintext", async () => {
    const app = getAppPool();
    const secret = "plaintext-must-not-be-stored";
    const { clientId } = await ensureDevClient(app, null, secret);

    const row = await app.query(
      `select "clientSecret" from app."oauthApplication" where "clientId"=$1`, [clientId]);
    const stored = row.rows[0].clientSecret;
    expect(stored).not.toBe(secret);
    expect(stored).not.toContain(secret);
    expect(stored).toBe(hashOauthClientSecret(secret));
  });

  // An instance created before hashing was on carries a plaintext row that would now fail
  // verification. The next boot has to fix it rather than leave the dev client unable to log in.
  it("rewrites a legacy plaintext row to a hash on the next call", async () => {
    const app = getAppPool();
    const secret = "legacy-rotation-secret";
    const { clientId } = await ensureDevClient(app, null, secret);
    // Simulate the pre-hash state.
    await app.query(
      `update app."oauthApplication" set "clientSecret"=$2 where "clientId"=$1`, [clientId, secret]);

    await ensureDevClient(app, null, secret);

    const row = await app.query(
      `select "clientSecret" from app."oauthApplication" where "clientId"=$1`, [clientId]);
    expect(row.rows[0].clientSecret).toBe(hashOauthClientSecret(secret));
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

    // Should return it now — the id only. The secret is not readable back by design.
    const found = await getDevClient(app);
    expect(found).toEqual({ clientId: created.clientId });
  });
});
