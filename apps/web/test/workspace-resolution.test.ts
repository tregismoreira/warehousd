import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { authorizeAndGetCode, pkcePair } from "./helpers/oauth";
import { upsertClientPolicy, setMember } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let marcusCookie: string;

beforeAll(async () => {
  db = await setupWebDb("wsresolve");
  const app = getAppPool();
  await app.query(
    `insert into app.workspaces (id, name) values ('w2', 'W2') on conflict do nothing`,
  );
  // Mia: member of 'default' (bootstrap) and 'w2' — two memberships, the case resolveWorkspace
  // must refuse to pick between. Marcus stays a member of 'default' only, for the
  // exactly-one-membership case.
  await setMember(app, { workspaceId: "w2", userId: "mia", role: "member" });
  marcusCookie = await signIn(db.auth, "marcus@harbor.demo", "demo");
}, 60_000);
afterAll(async () => {
  await db?.end();
});

describe("workspaceFromScopes", () => {
  it("parses workspace:w2, ignores env:live", async () => {
    const { workspaceFromScopes } = await import("../lib/workspace-scope");
    expect(workspaceFromScopes(["env:live", "workspace:w2"])).toBe("w2");
  });

  it("returns null on absence", async () => {
    const { workspaceFromScopes } = await import("../lib/workspace-scope");
    expect(workspaceFromScopes(["env:live"])).toBeNull();
  });
});

describe("resolveWorkspace truth table", () => {
  it("member + requested -> the id", async () => {
    const { resolveWorkspace } = await import("../lib/workspace-scope");
    expect(await resolveWorkspace(getAppPool(), "mia", "w2")).toBe("w2");
  });

  it("non-member + requested -> null", async () => {
    const { resolveWorkspace } = await import("../lib/workspace-scope");
    expect(await resolveWorkspace(getAppPool(), "marcus", "w2")).toBeNull();
  });

  it("no request + exactly one membership -> that id", async () => {
    const { resolveWorkspace } = await import("../lib/workspace-scope");
    expect(await resolveWorkspace(getAppPool(), "marcus", null)).toBe("default");
  });

  it("no request + two memberships -> null", async () => {
    const { resolveWorkspace } = await import("../lib/workspace-scope");
    expect(await resolveWorkspace(getAppPool(), "mia", null)).toBeNull();
  });
});

describe("all three constructors, one identity, one scope set", () => {
  // Marcus: one identity with exactly one membership ('default'), no `workspace:` scope
  // requested anywhere — that scope can never survive Better Auth's mcp authorize validation
  // (see lib/oauth.ts's comment at the drop site), so "one scope set" here is {env:dev} at
  // every boundary, and all three constructors have to reach the SAME workspaceId purely
  // through resolveWorkspace's no-request/exactly-one-membership fallback.
  it("deriveContext, deriveTokenContext, and deriveRestContext agree on workspaceId", async () => {
    const app = getAppPool();

    const { deriveContext } = await import("../lib/session");
    const sessionCtx = await deriveContext(
      new Request("http://localhost:8722/", { headers: { cookie: marcusCookie } }),
    );

    // One token, read by both deriveTokenContext (MCP) and deriveRestContext (REST) — both call
    // the identical auth.api.getMcpSession lookup, so one mint exercises both.
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "WS Resolve Client" },
      asResponse: true,
    } as any);
    const { client_id, client_secret } = await reg.json();
    await upsertClientPolicy(app, client_id, "WS Resolve Client", ["env:dev", "env:live"]);

    const { verifier, challenge } = pkcePair();
    const { code } = await authorizeAndGetCode(db.auth, {
      clientId: client_id,
      scope: "env:dev",
      cookie: marcusCookie,
      challenge,
    });
    const tokenRes = await db.auth.api.mcpOAuthToken({
      body: {
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:9999/callback",
        client_id,
        client_secret,
        code_verifier: verifier,
      },
      asResponse: true,
    } as any);
    const token = (await tokenRes.json()).access_token as string;
    const bearerReq = () =>
      new Request("http://localhost:8722/mcp", { headers: { authorization: `Bearer ${token}` } });

    const { deriveTokenContext } = await import("../lib/broker-context");
    const { deriveRestContext } = await import("../lib/rest-context");
    const tokenCtx = await deriveTokenContext(bearerReq());
    const restCtx = await deriveRestContext(bearerReq());

    // One equality check across all three, not three separate expectations.
    expect(new Set([sessionCtx?.workspaceId, tokenCtx?.workspaceId, restCtx?.workspaceId])).toEqual(
      new Set(["default"]),
    );
  });
});
