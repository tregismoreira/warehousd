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
  it("registers redirectUrls so the mcp/authorize flow accepts a stored session cookie", async () => {
    const app = getAppPool();

    const client = await ensureDevClient(app, null);

    const row = await app.query(
      `select "redirectUrls" from app."oauthApplication" where "clientId"=$1`,
      [client.clientId],
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
      [DEV_CLIENT_NAME],
    );
    expect(parseInt(check1.rows[0].cnt)).toBe(1);

    // Second call
    const second = await ensureDevClient(app, null, secret);
    expect(second.clientId).toBe(first.clientId);
    expect(second.clientSecret).toBe(secret);

    // Still exactly one row
    const check2 = await app.query(
      `select count(*) as cnt from app."oauthApplication" where name=$1`,
      [DEV_CLIENT_NAME],
    );
    expect(parseInt(check2.rows[0].cnt)).toBe(1);
  });

  // Stored verbatim, and this test exists to say why rather than to bless it.
  //
  // Better Auth's mcp plugin authenticates /mcp/token by comparing this column to the presented
  // value directly — `client.clientSecret === client_secret`, dist/plugins/mcp/index.mjs — not
  // through the oidc provider's configurable verifier. An earlier version of this file asserted
  // the opposite (that the column holds base64url(sha256(secret))), which storing a hash did
  // satisfy — while making every MCP token exchange fail with `invalid client_secret`. The unit
  // level could not see that, because the thing it broke was in the library's endpoint.
  //
  // So: hashing this column is not an improvement that was skipped, it is one the library
  // currently forecloses. SECURITY.md records it as a known limitation.
  it("stores the secret in the form the mcp token endpoint compares against", async () => {
    const app = getAppPool();
    const secret = "dev-client-secret-value";
    const { clientId, clientSecret } = await ensureDevClient(app, null, secret);

    const row = await app.query(
      `select "clientSecret" from app."oauthApplication" where "clientId"=$1`,
      [clientId],
    );
    expect(row.rows[0].clientSecret).toBe(secret);
    // The caller that supplied it gets it back, because nothing else can read it out later.
    expect(clientSecret).toBe(secret);
  });

  // A row left holding a hash by a build that hashed it would fail every token exchange. Supplying
  // the secret has to repair that rather than leave the dev client permanently unable to mint.
  it("repairs a row left holding a hash by an earlier build", async () => {
    const app = getAppPool();
    const secret = "legacy-rotation-secret";
    const { clientId } = await ensureDevClient(app, null, secret);
    const { createHash } = await import("node:crypto");
    await app.query(`update app."oauthApplication" set "clientSecret"=$2 where "clientId"=$1`, [
      clientId,
      createHash("sha256").update(secret).digest("base64url"),
    ]);

    await ensureDevClient(app, null, secret);

    const row = await app.query(
      `select "clientSecret" from app."oauthApplication" where "clientId"=$1`,
      [clientId],
    );
    expect(row.rows[0].clientSecret).toBe(secret);
  });

  it('after ensureDevClient, getClientPolicy returns exactly ["env:dev"]', async () => {
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
