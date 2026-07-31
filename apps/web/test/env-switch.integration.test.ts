import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { setupWebDbWithData, signIn } from "./helpers/web-db";

// POST /api/env sets the `wh_env` cookie, and `readEnvCookie` turns that cookie into the env every
// later request runs under — which decides whether the broker reads data_synth or data_live. It
// had no test.
//
// Two things are worth pinning. The value has to be validated rather than trusted, since it
// selects a database schema. And the cookie has to carry Secure whenever the request arrived over
// HTTPS: without it the value that chooses between synthetic and live data travels in clear text
// on the next plain-http request to the same host.
let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let miaCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("envswitch");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
}, 60_000);
afterAll(async () => {
  await db?.end();
});

function req(body: unknown, cookie?: string, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { "content-type": "application/json", ...headers };
  if (cookie) h["cookie"] = cookie;
  return new NextRequest("http://localhost:8722/api/env", {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
  });
}

function setCookie(res: Response) {
  return res.headers.get("set-cookie") ?? "";
}

describe("POST /api/env", () => {
  it("401s without a session", async () => {
    const { POST } = await import("../app/api/env/route");
    const res = await POST(req({ env: "live" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthenticated");
  });

  it("switches to live and says so in both the body and the cookie", async () => {
    const { POST } = await import("../app/api/env/route");
    const res = await POST(req({ env: "live" }, miaCookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, env: "live" });
    expect(setCookie(res)).toContain("wh_env=live");
  });

  it("switches back to dev", async () => {
    const { POST } = await import("../app/api/env/route");
    const res = await POST(req({ env: "dev" }, miaCookie));
    expect(res.status).toBe(200);
    expect(setCookie(res)).toContain("wh_env=dev");
  });

  // The value names a schema. Anything outside the two known envs is refused rather than coerced
  // to a default, and no cookie is set on the way out.
  it("400s on an env that is neither dev nor live", async () => {
    const { POST } = await import("../app/api/env/route");
    const res = await POST(req({ env: "data_live; drop" }, miaCookie));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid env");
    expect(setCookie(res)).not.toContain("wh_env");
  });

  it("400s when env is missing entirely", async () => {
    const { POST } = await import("../app/api/env/route");
    const res = await POST(req({}, miaCookie));
    expect(res.status).toBe(400);
    expect(setCookie(res)).not.toContain("wh_env");
  });

  it("is HttpOnly and SameSite=Lax, so script cannot read it and a cross-site POST cannot set it", async () => {
    const { POST } = await import("../app/api/env/route");
    const res = await POST(req({ env: "live" }, miaCookie));
    const cookie = setCookie(res);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });
});

describe("POST /api/env — the Secure flag follows the scheme", () => {
  it("omits Secure over plain http, so the cookie still works in local development", async () => {
    const { POST } = await import("../app/api/env/route");
    const res = await POST(req({ env: "live" }, miaCookie));
    expect(setCookie(res)).not.toContain("Secure");
  });

  // Behind a TLS-terminating proxy the request reaches the app over http and only the header says
  // otherwise. Reading the scheme alone would drop Secure on every deployment that has one.
  it("sets Secure when x-forwarded-proto says https", async () => {
    const { POST } = await import("../app/api/env/route");
    const res = await POST(req({ env: "live" }, miaCookie, { "x-forwarded-proto": "https" }));
    expect(setCookie(res)).toContain("Secure");
  });

  it("sets Secure when the request itself is https", async () => {
    const { POST } = await import("../app/api/env/route");
    const httpsReq = new NextRequest("https://warehousd.example/api/env", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: miaCookie },
      body: JSON.stringify({ env: "live" }),
    });
    const res = await POST(httpsReq);
    expect(setCookie(res)).toContain("Secure");
  });
});
