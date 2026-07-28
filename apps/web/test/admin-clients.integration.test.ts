import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { getClientPolicy } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let anaCookie: string, marcusCookie: string, miaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("adminclients");
  anaCookie = await signIn(db.auth, "ana@meridian.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@meridian.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

function req(url: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  return new Request(`http://localhost:8722${url}`, {
    method: opts.method ?? "GET", headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

async function createClient(cookie: string, name: string) {
  const { POST } = await import("../app/api/oauth-clients/route");
  const res = await POST(req("/api/oauth-clients", { method: "POST", cookie, body: { name } }) as any);
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

describe("client creation", () => {
  it("is admin-only", async () => {
    expect((await createClient(miaCookie, "nope")).status).toBe(403);
    expect((await createClient(marcusCookie, "nope")).status).toBe(403);
    expect((await createClient(anaCookie, "yes")).status).toBe(200);
  });

  it("always starts at {env:dev} even when the body asks for live", async () => {
    const { POST } = await import("../app/api/oauth-clients/route");
    const res = await POST(req("/api/oauth-clients", {
      method: "POST", cookie: anaCookie,
      body: { name: "Reporting", allowedScopes: ["env:dev", "env:live"] },
    }) as any);
    const { clientId } = await res.json();
    expect((await getClientPolicy(getAppPool(), clientId)).allowedScopes).toEqual(["env:dev"]);
  });

  it("returns the secret exactly once, at creation", async () => {
    const { body } = await createClient(anaCookie, "Once");
    expect(body.clientSecret).toBeTruthy();
    const { GET } = await import("../app/api/oauth-clients/route");
    const raw = await (await GET(req("/api/oauth-clients", { cookie: anaCookie }) as any)).text();
    expect(raw).not.toContain(body.clientSecret);
    expect(raw).not.toMatch(/clientSecret/);
  });
});

describe("GET /api/oauth-clients", () => {
  it("403s for a manager", async () => {
    const { GET } = await import("../app/api/oauth-clients/route");
    expect((await GET(req("/api/oauth-clients", { cookie: marcusCookie }) as any)).status).toBe(403);
  });

  it("lists clients with scopes and a null promotion trail before promotion", async () => {
    const { body } = await createClient(anaCookie, "Trail");
    const { GET } = await import("../app/api/oauth-clients/route");
    const list = await (await GET(req("/api/oauth-clients", { cookie: anaCookie }) as any)).json();
    const c = list.clients.find((x: any) => x.clientId === body.clientId);
    expect(c.allowedScopes).toEqual(["env:dev"]);
    expect(c.promotedAt).toBeNull();
    expect(c.promotedBy).toBeNull();
    expect(c.lastTokenAt).toBeNull();
  });

  it("shows the promotion trail after a manager promotes", async () => {
    const { body } = await createClient(anaCookie, "Promoted");
    const { POST } = await import("../app/api/oauth-clients/[clientId]/promote/route");
    await POST(req(`/api/oauth-clients/${body.clientId}/promote`, {
      method: "POST", cookie: marcusCookie, body: { action: "promote" },
    }) as any, { params: Promise.resolve({ clientId: body.clientId }) });

    const { GET } = await import("../app/api/oauth-clients/route");
    const list = await (await GET(req("/api/oauth-clients", { cookie: anaCookie }) as any)).json();
    const c = list.clients.find((x: any) => x.clientId === body.clientId);
    expect(c.allowedScopes.sort()).toEqual(["env:dev", "env:live"]);
    expect(c.promotedBy).toBe("marcus");
    expect(c.promotedAt).not.toBeNull();
  });

  it("reports lastTokenAt once a token exists for the client", async () => {
    const { body } = await createClient(anaCookie, "Tokened");
    // Insert a token row directly — minting a real one needs the full OAuth dance, which
    // oauth.integration.test.ts already covers. Column names come from Step 1.
    await getAppPool().query(
      `insert into app."oauthAccessToken"
         (id,"accessToken","refreshToken","accessTokenExpiresAt","refreshTokenExpiresAt",
          "clientId","userId",scopes,"createdAt","updatedAt")
       values ('t1','at','rt', now() + interval '15 min', now() + interval '7 day',
               $1,'ana','env:dev', now(), now())`,
      [body.clientId]);

    const { GET } = await import("../app/api/oauth-clients/route");
    const list = await (await GET(req("/api/oauth-clients", { cookie: anaCookie }) as any)).json();
    expect(list.clients.find((x: any) => x.clientId === body.clientId).lastTokenAt).not.toBeNull();
  });
});
