import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb } from "./helpers/web-db";
import { createClientSecret, loadConfig } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

const _harborCfg = loadConfig(new URL("../../../examples/harbor", import.meta.url).pathname);

let db: Awaited<ReturnType<typeof setupWebDb>>;

beforeAll(async () => {
  db = await setupWebDb("tokenexchange");
}, 60_000);
afterAll(async () => {
  await db?.end();
});

// eslint-disable-next-line @typescript-eslint/require-await -- callers await this; see await-thenable
async function req(
  url: string,
  opts: { method?: string; body?: string; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    ...opts.headers,
  };
  return new Request(`http://localhost:8722${url}`, {
    method: opts.method ?? "POST",
    headers,
    // Conditional spread: RequestInit's `body` must be absent, not present-and-undefined.
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
}

describe("POST /v1/token — RFC 8693 token exchange", () => {
  it("rejects unknown client", async () => {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "unknown",
      client_secret: "whd_dev_x_y_z",
    }).toString();
    const { POST } = await import("../app/v1/token/route");
    const res = await POST((await req("/v1/token", { body })) as any);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("invalid_client");
  });

  it("headless mode with client_credentials", async () => {
    const pool = getAppPool();

    // Register OAuth application
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Headless Test" },
      asResponse: true,
    } as any);
    const { client_id: clientId } = await reg.json();

    // Update client policy (registerMcpClient already created one)
    await pool.query(
      `update app.client_policies set mode=$2, robot_user_id=$3 where client_id=$1`,
      [clientId, "headless", "mia"],
    );

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 365);
    const { secret } = await createClientSecret(
      pool,
      clientId,
      "default",
      expiryDate,
      "ana",
      "dev",
    );

    // Request token
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: secret,
      scope: "env:dev",
    }).toString();

    const { POST } = await import("../app/v1/token/route");
    const res = await POST((await req("/v1/token", { body })) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.access_token).toBeTruthy();
    expect(data.token_type).toBe("Bearer");
    expect(data.expires_in).toBe(900);
    expect(data.scope).toContain("env:dev");
    expect(data.issued_token_type).toBe("urn:ietf:params:oauth:token-type:access_token");
  });

  it("delegated client cannot use client_credentials", async () => {
    const pool = getAppPool();

    // Register OAuth application
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Delegated Test" },
      asResponse: true,
    } as any);
    const { client_id: clientId } = await reg.json();

    // Update client policy to delegated mode
    await pool.query(`update app.client_policies set mode=$2 where client_id=$1`, [
      clientId,
      "delegated",
    ]);

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 365);
    const { secret } = await createClientSecret(
      pool,
      clientId,
      "default",
      expiryDate,
      "ana",
      "dev",
    );

    // Try client_credentials flow (should fail)
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: secret,
    }).toString();

    const { POST } = await import("../app/v1/token/route");
    const res = await POST((await req("/v1/token", { body })) as any);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("unauthorized_client");
  });

  it("headless client cannot use token-exchange", async () => {
    const pool = getAppPool();

    // Register OAuth application
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Headless Test 2" },
      asResponse: true,
    } as any);
    const { client_id: clientId } = await reg.json();

    // Update client policy to headless mode
    await pool.query(
      `update app.client_policies set mode=$2, robot_user_id=$3 where client_id=$1`,
      [clientId, "headless", "mia"],
    );

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 365);
    const { secret } = await createClientSecret(
      pool,
      clientId,
      "default",
      expiryDate,
      "ana",
      "dev",
    );

    // Try token-exchange flow (should fail)
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      client_id: clientId,
      client_secret: secret,
      subject_token: "fake-jwt",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    }).toString();

    const { POST } = await import("../app/v1/token/route");
    const res = await POST((await req("/v1/token", { body })) as any);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("unauthorized_client");
  });

  it("client_credentials requires robot_user_id", async () => {
    const pool = getAppPool();

    // Register OAuth application
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "No Robot" },
      asResponse: true,
    } as any);
    const { client_id: clientId } = await reg.json();

    // Update client policy to headless mode WITHOUT robot_user_id
    await pool.query(`update app.client_policies set mode=$2 where client_id=$1`, [
      clientId,
      "headless",
    ]);

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 365);
    const { secret } = await createClientSecret(
      pool,
      clientId,
      "default",
      expiryDate,
      "ana",
      "dev",
    );

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: secret,
    }).toString();

    const { POST } = await import("../app/v1/token/route");
    const res = await POST((await req("/v1/token", { body })) as any);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid_request");
  });

  it("rejects both Basic and form-field auth", async () => {
    const pool = getAppPool();

    // Register OAuth application
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Dual Auth" },
      asResponse: true,
    } as any);
    const { client_id: clientId } = await reg.json();

    // Update client policy to headless mode
    await pool.query(
      `update app.client_policies set mode=$2, robot_user_id=$3 where client_id=$1`,
      [clientId, "headless", "mia"],
    );

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 365);
    const { secret } = await createClientSecret(
      pool,
      clientId,
      "default",
      expiryDate,
      "ana",
      "dev",
    );

    const basicAuth = Buffer.from(`${clientId}:${secret}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: secret,
    }).toString();

    const { POST } = await import("../app/v1/token/route");
    const res = await POST(
      (await req("/v1/token", {
        body,
        headers: { authorization: `Basic ${basicAuth}` },
      })) as any,
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid_request");
  });

  it("Basic auth works correctly", async () => {
    const pool = getAppPool();

    // Register OAuth application
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Basic Auth Test" },
      asResponse: true,
    } as any);
    const { client_id: clientId } = await reg.json();

    // Update client policy (registerMcpClient already created one)
    await pool.query(
      `update app.client_policies set mode=$2, robot_user_id=$3 where client_id=$1`,
      [clientId, "headless", "mia"],
    );

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 365);
    const { secret } = await createClientSecret(
      pool,
      clientId,
      "default",
      expiryDate,
      "ana",
      "dev",
    );

    const basicAuth = Buffer.from(`${clientId}:${secret}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      scope: "env:dev",
    }).toString();

    const { POST } = await import("../app/v1/token/route");
    const res = await POST(
      (await req("/v1/token", {
        body,
        headers: { authorization: `Basic ${basicAuth}` },
      })) as any,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.access_token).toBeTruthy();
  });

  it("cache-control: no-store on all responses", async () => {
    const pool = getAppPool();

    // Register OAuth application
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Cache Test" },
      asResponse: true,
    } as any);
    const { client_id: clientId } = await reg.json();

    // Update client policy (registerMcpClient already created one)
    await pool.query(
      `update app.client_policies set mode=$2, robot_user_id=$3 where client_id=$1`,
      [clientId, "headless", "mia"],
    );

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 365);
    const { secret } = await createClientSecret(
      pool,
      clientId,
      "default",
      expiryDate,
      "ana",
      "dev",
    );

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: secret,
    }).toString();

    const { POST } = await import("../app/v1/token/route");
    const res = await POST((await req("/v1/token", { body })) as any);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("resolves scopes via policy and eligibility", async () => {
    const pool = getAppPool();

    // Register OAuth application
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Scope Test" },
      asResponse: true,
    } as any);
    const { client_id: clientId } = await reg.json();

    // Update client policy (registerMcpClient already created one)
    await pool.query(
      `update app.client_policies set mode=$2, robot_user_id=$3, allowed_scopes=$4 where client_id=$1`,
      [clientId, "headless", "mia", ["env:dev", "env:live"]],
    );

    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 365);
    const { secret } = await createClientSecret(
      pool,
      clientId,
      "default",
      expiryDate,
      "ana",
      "dev",
    );

    // Request both scopes but user has no live grant
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: secret,
      scope: "env:dev env:live",
    }).toString();

    const { POST } = await import("../app/v1/token/route");
    const res = await POST((await req("/v1/token", { body })) as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    // Should only get env:dev since no live grant
    expect(data.scope).toBe("env:dev");
  });
});
