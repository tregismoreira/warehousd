import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb } from "./helpers/web-db";

let db: Awaited<ReturnType<typeof setupWebDb>>;

beforeAll(async () => {
  db = await setupWebDb("oauth");
}, 60_000);
afterAll(async () => {
  await db?.end();
});

describe("OAuth provider wiring", () => {
  it("exposes the well-known authorization server metadata", async () => {
    const res = await db.auth.api.getMcpOAuthConfig({ asResponse: true } as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scopes_supported).toEqual(
      expect.arrayContaining(["openid", "profile", "email", "offline_access"]),
    );
    expect(body.token_endpoint).toMatch(/\/mcp\/token$/);
  });

  it("dynamic client registration creates a client", async () => {
    const res = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Test DCR Client" },
      asResponse: true,
    } as any);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toBeTruthy();
  });
});
