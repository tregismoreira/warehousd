import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { upsertClientPolicy, createClientSecret } from "@warehousd/broker";
import { setupWebDb, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

// A body that isn't a JSON object must refuse with a 400, not fall through to `req.json()`
// throwing and the framework answering 500 — a parser fault reported as a server fault tells the
// caller to retry something that will never work.
//
// One helper (`readJson` in lib/rest.ts) guards every one of these routes, so this suite covers a
// representative route per surface rather than all sixteen: the /v1 surface answers in broker
// reason codes (`invalid_intent`), the console surface in its own (`invalid_body`).
const BAD_BODIES: Array<[string, string]> = [
  ["a parse error", "["],
  ["a JSON array", "[]"],
  ["a JSON scalar", "42"],
];

let db: Awaited<ReturnType<typeof setupWebDb>>;
let bearer: string;
let miaCookie: string;
let anaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("malformedbody");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
  anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");

  // A headless client-credentials token is the cheapest bearer that satisfies
  // deriveRestContext — no grant is needed, since every route below refuses on the body long
  // before it reaches the broker.
  const app = getAppPool();
  const reg = await db.auth.api.registerMcpClient({
    body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "malformed-body" },
    asResponse: true,
  } as any);
  const { client_id } = await reg.json();
  await upsertClientPolicy(app, client_id, "malformed-body", ["env:dev"]);
  await app.query(
    `update app.client_policies set mode='headless', robot_user_id=$1 where client_id=$2`,
    ["mia", client_id],
  );
  const { secret } = await createClientSecret(
    app,
    client_id,
    "default",
    new Date(Date.now() + 86_400_000),
    "test",
  );

  const { POST } = await import("../app/v1/token/route");
  const res = await POST(
    new Request("http://localhost:8722/v1/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id,
        client_secret: secret,
        scope: "env:dev",
      }).toString(),
    }) as any,
  );
  bearer = (await res.json()).access_token;
  expect(bearer).toBeTruthy();
}, 60_000);

afterAll(async () => {
  await db?.end();
});

function raw(url: string, method: string, body: string, headers: Record<string, string>) {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("/v1 routes refuse a body that is not a JSON object", () => {
  for (const [label, body] of BAD_BODIES) {
    it(`POST /v1/grants — ${label}`, async () => {
      const { POST } = await import("../app/v1/grants/route");
      const res = await POST(
        raw("http://localhost:8722/v1/grants", "POST", body, { authorization: `Bearer ${bearer}` }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_intent" });
    });

    it(`POST /v1/collections/[c]/documents — ${label}`, async () => {
      const { POST } = await import("../app/v1/collections/[c]/documents/route");
      const res = await POST(
        raw("http://localhost:8722/v1/collections/feedback/documents", "POST", body, {
          authorization: `Bearer ${bearer}`,
        }),
        { params: Promise.resolve({ c: "feedback" }) },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_intent" });
    });

    it(`PUT /v1/collections/[c]/documents/[id] — ${label}`, async () => {
      const { PUT } = await import("../app/v1/collections/[c]/documents/[id]/route");
      const res = await PUT(
        raw("http://localhost:8722/v1/collections/feedback/documents/1", "PUT", body, {
          authorization: `Bearer ${bearer}`,
        }),
        { params: Promise.resolve({ c: "feedback", id: "1" }) },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_intent" });
    });
  }
});

describe("console /api routes refuse a body that is not a JSON object", () => {
  for (const [label, body] of BAD_BODIES) {
    it(`POST /api/env — ${label}`, async () => {
      const { POST } = await import("../app/api/env/route");
      const res = await POST(
        raw("http://localhost:8722/api/env", "POST", body, {
          cookie: miaCookie,
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
      // No env cookie leaves on a refusal — the value chooses a schema.
      expect(res.headers.get("set-cookie") ?? "").not.toContain("wh_env");
    });

    it(`POST /api/grants — ${label}`, async () => {
      const { POST } = await import("../app/api/grants/route");
      const res = await POST(
        raw("http://localhost:8722/api/grants", "POST", body, { cookie: miaCookie }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    });

    // This one hands the request on to Better Auth rather than reading the parsed value, so the
    // guard is a clone-and-probe. Worth its own case: the parse check and the hand-off are two
    // reads of the same body, and getting that wrong shows up as a 500 again.
    it(`POST /api/sso/providers — ${label}`, async () => {
      const { POST } = await import("../app/api/sso/providers/route");
      const res = await POST(
        raw("http://localhost:8722/api/sso/providers", "POST", body, { cookie: anaCookie }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    });

    it(`POST /api/api-keys — ${label}`, async () => {
      const { POST } = await import("../app/api/api-keys/route");
      const res = await POST(
        raw("http://localhost:8722/api/api-keys", "POST", body, { cookie: anaCookie }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    });
  }
});

// The guard sits behind the auth check, not in front of it: a malformed body from an
// unauthenticated caller is still an authentication failure, and answering 400 would confirm the
// route exists to someone who may not know that.
describe("the body guard does not run ahead of the auth guard", () => {
  it("POST /v1/grants without a bearer is 401, not 400", async () => {
    const { POST } = await import("../app/v1/grants/route");
    const res = await POST(raw("http://localhost:8722/v1/grants", "POST", "[", {}));
    expect(res.status).toBe(401);
  });

  it("POST /api/env without a session is 401, not 400", async () => {
    const { POST } = await import("../app/api/env/route");
    const res = await POST(raw("http://localhost:8722/api/env", "POST", "[", {}));
    expect(res.status).toBe(401);
  });
});
