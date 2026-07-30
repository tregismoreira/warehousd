import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let miaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("connectinfo");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
}, 60_000);
afterAll(async () => {
  await db?.end();
});

function req(cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  return new Request("http://localhost:8722/api/connect-info", { headers });
}

describe("GET /api/connect-info", () => {
  it("401s without a session", async () => {
    const { GET } = await import("../app/api/connect-info/route");
    expect((await GET(req() as any)).status).toBe(401);
  });

  it("returns the MCP endpoint derived from BETTER_AUTH_URL, never from the request", async () => {
    const { GET } = await import("../app/api/connect-info/route");
    const body = await (await GET(req(miaCookie) as any)).json();
    expect(body.mcpUrl).toBe(`${process.env.BETTER_AUTH_URL}/mcp`);
    expect(body.scopes).toEqual(["env:dev", "env:live"]);
  });

  it("never returns a client secret or a token", async () => {
    const { GET } = await import("../app/api/connect-info/route");
    const raw = await (await GET(req(miaCookie) as any)).text();
    expect(raw).not.toMatch(/secret/i);
    expect(raw).not.toMatch(/access_token/i);
  });
});
