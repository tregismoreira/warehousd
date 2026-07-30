import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { getClientPolicy } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let anaCookie: string, miaCookie: string, marcusCookie: string;

beforeAll(async () => {
  db = await setupWebDb("oauthclients");
  anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@harbor.demo", "demo");
}, 60_000);
afterAll(async () => {
  await db?.end();
});

function req(url: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  return new Request(`http://localhost:8722${url}`, {
    method: opts.method ?? "GET",
    headers,
    // Conditional spread, not `body: … : undefined`: under `exactOptionalPropertyTypes` a
    // present-but-undefined `body` is not the same as an absent one, and RequestInit wants absent.
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe("manual client creation", () => {
  it("admin can create a client; it always starts with {env:dev} — no override", async () => {
    const { POST } = await import("../app/api/oauth-clients/route");
    const res = await POST(
      req("/api/oauth-clients", {
        method: "POST",
        cookie: anaCookie,
        body: { name: "My Reporting App", allowedScopes: ["env:dev", "env:live"] }, // attempted override
      }) as any,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clientId).toBeTruthy();
    expect(body.clientSecret).toBeTruthy();
    const policy = await getClientPolicy(getAppPool(), body.clientId);
    expect(policy.allowedScopes).toEqual(["env:dev"]);
  });

  it("member gets 403 when trying to create a client", async () => {
    const { POST } = await import("../app/api/oauth-clients/route");
    const res = await POST(
      req("/api/oauth-clients", {
        method: "POST",
        cookie: miaCookie,
        body: { name: "Nope" },
      }) as any,
    );
    expect(res.status).toBe(403);
  });
});

describe("promotion/demotion", () => {
  it("member cannot promote → 403", async () => {
    const { POST: createClient } = await import("../app/api/oauth-clients/route");
    const created = await (
      await createClient(
        req("/api/oauth-clients", {
          method: "POST",
          cookie: anaCookie,
          body: { name: "App" },
        }) as any,
      )
    ).json();

    const { POST } = await import("../app/api/oauth-clients/[clientId]/promote/route");
    const res = await POST(
      req(`/api/oauth-clients/${created.clientId}/promote`, {
        method: "POST",
        cookie: miaCookie,
        body: { action: "promote" },
      }) as any,
      { params: Promise.resolve({ clientId: created.clientId }) },
    );
    expect(res.status).toBe(403);
  });

  it("manager can promote, stamping promoted_by; and demote", async () => {
    const { POST: createClient } = await import("../app/api/oauth-clients/route");
    const created = await (
      await createClient(
        req("/api/oauth-clients", {
          method: "POST",
          cookie: anaCookie,
          body: { name: "App" },
        }) as any,
      )
    ).json();

    const { POST } = await import("../app/api/oauth-clients/[clientId]/promote/route");
    const promoteRes = await POST(
      req(`/api/oauth-clients/${created.clientId}/promote`, {
        method: "POST",
        cookie: marcusCookie,
        body: { action: "promote" },
      }) as any,
      { params: Promise.resolve({ clientId: created.clientId }) },
    );
    expect(promoteRes.status).toBe(200);
    let policy = await getClientPolicy(getAppPool(), created.clientId);
    expect(policy.allowedScopes.sort()).toEqual(["env:dev", "env:live"]);

    const demoteRes = await POST(
      req(`/api/oauth-clients/${created.clientId}/promote`, {
        method: "POST",
        cookie: marcusCookie,
        body: { action: "demote" },
      }) as any,
      { params: Promise.resolve({ clientId: created.clientId }) },
    );
    expect(demoteRes.status).toBe(200);
    policy = await getClientPolicy(getAppPool(), created.clientId);
    expect(policy.allowedScopes).toEqual(["env:dev"]);
  });
});
