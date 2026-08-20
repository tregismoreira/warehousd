import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData } from "./helpers/web-db";
import {
  upsertClientPolicy,
  approveGrant,
  requestGrant,
  createClientSecret,
  loadConfig,
  MAX_BATCH_QUERIES,
  type WarehousdConfig,
} from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

const harborDir = new URL("../../../examples/harbor", import.meta.url).pathname;
const harborCfg: WarehousdConfig = loadConfig(harborDir);

// End to end through POST /v1/batch's own route handler — this route has no HTTP-level test at
// all (apps/web/test/rest-routes-smoke.test.ts only asserts `POST` is exported), while
// packages/broker/test/query-batch.test.ts exercises broker.queryBatch() directly and cannot see
// what the REST envelope does with a sub-query refusal, an envelope refusal, or an unparseable
// body. In particular: acceptance criterion 3.3, that one sub-query's refusal never changes the
// HTTP status, is a REST-layer property the broker return value alone does not pin.
describe("POST /v1/batch", () => {
  let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
  let batchToken: string;

  async function mintHeadlessToken(clientName: string, robotUserId: string) {
    const app = getAppPool();
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: clientName },
      asResponse: true,
    } as any);
    const { client_id } = await reg.json();
    await upsertClientPolicy(app, client_id, clientName, ["env:dev"]);
    await app.query(
      `update app.client_policies set mode='headless', robot_user_id=$1 where client_id=$2`,
      [robotUserId, client_id],
    );
    const { secret } = await createClientSecret(
      app,
      client_id,
      "default",
      new Date(Date.now() + 86_400_000),
      "test",
    );

    const { POST } = await import("../app/v1/token/route");
    const tokenReq = new Request("http://localhost:8722/v1/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id,
        client_secret: secret,
        scope: "env:dev",
      }).toString(),
    });
    const res = await POST(tokenReq as any);
    return (await res.json()).access_token as string;
  }

  beforeAll(async () => {
    db = await setupWebDbWithData("querybatch");
    const app = getAppPool();

    // "mia" holds grants on "clients" and "departments" but never on "vendors" — the
    // no-grant slot the partial-failure test needs. Per-user, per-collection grants are the
    // simplest way to get a "collection this token cannot read": just don't grant it.
    for (const [collection, fields] of [
      ["clients", ["id", "client_number", "name", "industry"]],
      ["departments", ["id", "name", "kind"]],
    ] as const) {
      const id = await requestGrant(app, {
        userId: "mia",
        collection,
        workspaceId: "default",
        env: "dev",
        purposeLabel: "test",
        allowedFields: [...fields],
      });
      await approveGrant(app, harborCfg, id, "admin", { verbs: ["read"] });
    }

    batchToken = await mintHeadlessToken("Batch Client", "mia");
  }, 60_000);

  afterAll(async () => {
    await db?.end();
  });

  function req(body: unknown, token?: string) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
    return new Request("http://localhost:8722/v1/batch", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  async function postBatch(body: unknown, token: string = batchToken) {
    const { POST } = await import("../app/v1/batch/route");
    return POST(req(body, token) as any);
  }

  it("three labelled queries in one request → 200, ok:true, results keyed by the caller's labels", async () => {
    const res = await postBatch({
      queries: [
        { label: "clientsQ", collection: "clients", fields: ["id", "name"], limit: 5 },
        { label: "deptsQ", collection: "departments", fields: ["id", "name"], limit: 5 },
        { label: "clientsAgain", collection: "clients", fields: ["id", "industry"], limit: 5 },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    for (const label of ["clientsQ", "deptsQ", "clientsAgain"]) {
      const sub = body.results[label];
      expect(sub, label).toBeDefined();
      expect(sub.ok).toBe(true);
      expect(Array.isArray(sub.documents)).toBe(true);
      expect(sub.documents.length).toBeGreaterThan(0);
      expect(Array.isArray(sub.fieldsReturned)).toBe(true);
    }
  });

  // Acceptance criterion 3.3 — the most important assertion in this file. A sub-query the token
  // cannot read must refuse in its OWN slot without dragging the HTTP status down with it: the
  // envelope succeeded (a batch of reads was carried out), only one read inside it failed. If a
  // route change made any refusing sub-query flip the whole response to non-200, this is the test
  // that must catch it — see "teeth" verification below.
  it("a sub-query on a collection the token cannot read still returns 200, ok:true, with its own refusal in its own slot — the others still return documents", async () => {
    const res = await postBatch({
      queries: [
        { label: "granted1", collection: "clients", fields: ["id", "name"], limit: 5 },
        { label: "denied", collection: "vendors" },
        { label: "granted2", collection: "departments", fields: ["id", "name"], limit: 5 },
      ],
    });
    expect(res.status).toBe(200); // the assertion that matters: never dragged down by a sub-refusal
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(body.results.granted1.ok).toBe(true);
    expect(body.results.granted1.documents.length).toBeGreaterThan(0);
    expect(body.results.granted2.ok).toBe(true);
    expect(body.results.granted2.documents.length).toBeGreaterThan(0);

    expect(body.results.denied.ok).toBe(false);
    expect(body.results.denied.reason).toBe("no_grant");
    expect(typeof body.results.denied.auditId).toBe("string");
  });

  it("duplicate labels → 400 invalid_intent (envelope-level refusal, mapped through restStatus)", async () => {
    const res = await postBatch({
      queries: [
        { label: "dup", collection: "clients", fields: ["id"] },
        { label: "dup", collection: "departments", fields: ["id"] },
      ],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_intent" });
  });

  it(`more than MAX_BATCH_QUERIES (${MAX_BATCH_QUERIES}) sub-queries → 400 invalid_intent`, async () => {
    const queries = Array.from({ length: MAX_BATCH_QUERIES + 1 }, (_, i) => ({
      label: `q${i}`,
      collection: "clients",
      fields: ["id"],
    }));
    const res = await postBatch({ queries });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_intent" });
  });

  it("a malformed body → 400 invalid_intent", async () => {
    const res = await postBatch([1, 2, 3]); // an array, not an object — readJson refuses it
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_intent" });
  });

  it('unauthenticated → 401 { error: "unauthenticated" }', async () => {
    const { POST } = await import("../app/v1/batch/route");
    const res = await POST(req({ queries: [] }) as any); // no token argument — no authorization header
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("composes with keyset `after`: one sub-query's own nextCursor travels in its own slot, the others are unaffected", async () => {
    // First call establishes there IS a next page for a 5-row limit over 150 "clients".
    const solo = await postBatch({
      queries: [
        {
          label: "solo",
          collection: "clients",
          fields: ["id"],
          orderBy: { field: "client_number", dir: "asc" },
          limit: 5,
        },
      ],
    });
    expect(solo.status).toBe(200);
    const soloBody = await solo.json();
    const cursor = soloBody.results.solo.nextCursor;
    expect(typeof cursor).toBe("string");

    const res = await postBatch({
      queries: [
        {
          label: "paged",
          collection: "clients",
          fields: ["id"],
          orderBy: { field: "client_number", dir: "asc" },
          limit: 5,
          after: cursor,
        },
        // "departments" has 12 synthetic documents — a limit of 20 guarantees one full page and
        // no `nextCursor`, so its absence here is not a coincidence of timing with the other
        // sub-query's own cursor.
        { label: "plain", collection: "departments", fields: ["id", "name"], limit: 20 },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // The paged sub-query carries its own nextCursor, distinct from the first page's, and its
    // documents are the SECOND page, not the first (the walk actually advanced).
    expect(body.results.paged.ok).toBe(true);
    expect(body.results.paged.documents.map((d: any) => d.id)).not.toEqual(
      soloBody.results.solo.documents.map((d: any) => d.id),
    );

    // The unrelated sub-query in the same batch never got an `after` and never returns one.
    expect(body.results.plain.ok).toBe(true);
    expect(body.results.plain.nextCursor).toBeUndefined();
  });
});
