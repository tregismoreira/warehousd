import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithConfig, signIn } from "./helpers/web-db";
import { upsertClientPolicy, approveGrant, requestGrant, createClientSecret } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

const fixtureDir = new URL("./fixtures/rest-api", import.meta.url).pathname;

// Two personas, two grants, one collection ("feedback", writable): marcus gets a direct-mode
// grant with every verb (including approve) for the CRUD/read-side happy paths; mia gets a
// proposal_only-mode grant with only create+read, so her creates land as pending proposals for
// marcus to approve/reject. Two personas are required — loadActiveGrant picks one active grant
// per (user, collection, env, org), so a single user can't hold both modes at once.
describe("REST API /v1/* routes", () => {
  let db: Awaited<ReturnType<typeof setupWebDbWithConfig>>;
  let marcusToken: string;
  let miaToken: string;
  let miaCookie: string;

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
      [robotUserId, client_id]);
    const { secret } = await createClientSecret(app, client_id, "default", new Date(Date.now() + 86_400_000), "test");

    const { POST } = await import("../app/v1/token/route");
    const tokenReq = new Request("http://localhost:8722/v1/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials", client_id, client_secret: secret, scope: "env:dev",
      }).toString(),
    });
    const res = await POST(tokenReq as any);
    return (await res.json()).access_token as string;
  }

  beforeAll(async () => {
    db = await setupWebDbWithConfig("restapi", fixtureDir);
    miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
    const app = getAppPool();
    const fields = ["id", "title", "message", "submitted_by", "created_at"];

    const marcusGrant = await requestGrant(app, {
      userId: "marcus", collection: "feedback", orgId: "default", env: "dev",
      purposeLabel: "test", allowedFields: fields,
    });
    await approveGrant(app, db.cfg, marcusGrant, "marcus", {
      verbs: ["read", "create", "update", "delete", "approve"], mode: "direct",
    });

    const miaGrant = await requestGrant(app, {
      userId: "mia", collection: "feedback", orgId: "default", env: "dev",
      purposeLabel: "test", allowedFields: fields,
    });
    await approveGrant(app, db.cfg, miaGrant, "marcus", {
      verbs: ["read", "create"], mode: "proposal_only",
    });

    marcusToken = await mintHeadlessToken("Marcus Client", "marcus");
    miaToken = await mintHeadlessToken("Mia Client", "mia");
  }, 60_000);

  afterAll(async () => { await db?.end(); });

  function req(path: string, opts: { method?: string; body?: unknown; token?: string; cookie?: string; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
    if (opts.cookie) headers["cookie"] = opts.cookie;
    else headers["authorization"] = `Bearer ${opts.token ?? marcusToken}`;
    return new Request(`http://localhost:8722${path}`, {
      method: opts.method ?? "GET", headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  }

  describe("authentication", () => {
    it("no auth → 401 unauthenticated", async () => {
      const { GET } = await import("../app/v1/collections/route");
      const res = await GET(new Request("http://localhost:8722/v1/collections", { headers: {} }) as any);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthenticated" });
    });

    it("a session cookie alone cannot reach /v1/*", async () => {
      const { GET } = await import("../app/v1/collections/route");
      const res = await GET(req("/v1/collections", { cookie: miaCookie }) as any);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthenticated" });
    });
  });

  describe("GET /v1/collections", () => {
    it("lists collections", async () => {
      const { GET } = await import("../app/v1/collections/route");
      const res = await GET(req("/v1/collections") as any);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.map((c: any) => c.name)).toContain("feedback");
    });
  });

  describe("GET /v1/collections/[c]", () => {
    it("describes a collection", async () => {
      const { GET } = await import("../app/v1/collections/[c]/route");
      const res = await GET(req("/v1/collections/feedback") as any, { params: Promise.resolve({ c: "feedback" }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.collection).toBe("feedback");
    });

    it("unknown collection → 404", async () => {
      const { GET } = await import("../app/v1/collections/[c]/route");
      const res = await GET(req("/v1/collections/nope") as any, { params: Promise.resolve({ c: "nope" }) });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown_collection" });
    });
  });

  describe("document lifecycle (marcus, direct grant)", () => {
    let docId: string;
    let etag: string;

    it("POST /v1/collections/[c]/documents creates → 201 with Location", async () => {
      const { POST } = await import("../app/v1/collections/[c]/documents/route");
      const res = await POST(
        req("/v1/collections/feedback/documents", { method: "POST", body: { title: "Hello", message: "World", submitted_by: "marcus" } }) as any,
        { params: Promise.resolve({ c: "feedback" }) });
      expect(res.status).toBe(201);
      const body = await res.json();
      docId = body.documentId;
      expect(docId).toBeDefined();
      expect(res.headers.get("location")).toBe(`/v1/collections/feedback/documents/${docId}`);
    });

    it("GET /v1/collections/[c]/documents/[id] retrieves it with ETag", async () => {
      const { GET } = await import("../app/v1/collections/[c]/documents/[id]/route");
      const res = await GET(req(`/v1/collections/feedback/documents/${docId}`) as any, { params: Promise.resolve({ c: "feedback", id: docId }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.document.id).toBe(docId);
      etag = res.headers.get("etag")!;
      expect(etag).toBeTruthy();
    });

    it("unknown document → 404 not_found", async () => {
      const { GET } = await import("../app/v1/collections/[c]/documents/[id]/route");
      const res = await GET(
        req("/v1/collections/feedback/documents/00000000-0000-0000-0000-000000000000") as any,
        { params: Promise.resolve({ c: "feedback", id: "00000000-0000-0000-0000-000000000000" }) });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    });

    it("PUT with correct If-Match → 200 and a new ETag", async () => {
      const { PUT } = await import("../app/v1/collections/[c]/documents/[id]/route");
      const updateReq = req(`/v1/collections/feedback/documents/${docId}`, {
        method: "PUT", body: { title: "Updated", message: "World", submitted_by: "marcus" },
        headers: { "if-match": etag },
      });
      const res = await PUT(updateReq as any, { params: Promise.resolve({ c: "feedback", id: docId }) });
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBeTruthy();
      expect(res.headers.get("etag")).not.toBe(etag);
    });

    it("PUT with stale If-Match → 412 conflict", async () => {
      const { PUT } = await import("../app/v1/collections/[c]/documents/[id]/route");
      const updateReq = req(`/v1/collections/feedback/documents/${docId}`, {
        method: "PUT", body: { title: "Should fail", message: "x", submitted_by: "marcus" },
        headers: { "if-match": etag }, // the now-stale ETag from before the update above
      });
      const res = await PUT(updateReq as any, { params: Promise.resolve({ c: "feedback", id: docId }) });
      expect(res.status).toBe(412);
      expect(await res.json()).toEqual({ error: "conflict" });
    });

    it("GET /v1/collections/[c]/documents/[id]/revisions lists revision history", async () => {
      const { GET } = await import("../app/v1/collections/[c]/documents/[id]/revisions/route");
      const res = await GET(req(`/v1/collections/feedback/documents/${docId}/revisions`) as any, { params: Promise.resolve({ c: "feedback", id: docId }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.revisions.length).toBeGreaterThanOrEqual(2); // create + the successful update
    });

    it("DELETE removes it → 204 with no body", async () => {
      const { DELETE } = await import("../app/v1/collections/[c]/documents/[id]/route");
      const res = await DELETE(req(`/v1/collections/feedback/documents/${docId}`, { method: "DELETE" }) as any, { params: Promise.resolve({ c: "feedback", id: docId }) });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    });

    it("DELETE on an unknown document → 404 not_found", async () => {
      const { DELETE } = await import("../app/v1/collections/[c]/documents/[id]/route");
      const res = await DELETE(
        req("/v1/collections/feedback/documents/00000000-0000-0000-0000-000000000000", { method: "DELETE" }) as any,
        { params: Promise.resolve({ c: "feedback", id: "00000000-0000-0000-0000-000000000000" }) });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    });
  });

  describe("POST /v1/collections/[c]/query", () => {
    it("queries a collection → 200", async () => {
      const { POST } = await import("../app/v1/collections/[c]/query/route");
      const res = await POST(
        req("/v1/collections/feedback/query", { method: "POST", body: { fields: ["id"], filters: [] } }) as any,
        { params: Promise.resolve({ c: "feedback" }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.documents)).toBe(true);
    });

    it("unknown collection → 404 unknown_collection", async () => {
      const { POST } = await import("../app/v1/collections/[c]/query/route");
      const res = await POST(
        req("/v1/collections/bogus/query", { method: "POST", body: { fields: ["id"], filters: [] } }) as any,
        { params: Promise.resolve({ c: "bogus" }) });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown_collection" });
    });
  });

  describe("GET /v1/collections/[c]/search", () => {
    // "feedback" is a dataset with no field marked searchable: true — searchDocuments refuses
    // invalid_intent (400) for that, distinct from the not_writable/verb_not_supported family
    // that covers mutating a file collection below.
    it("on a collection with no searchable fields → 400 invalid_intent", async () => {
      const { GET } = await import("../app/v1/collections/[c]/search/route");
      const res = await GET(req("/v1/collections/feedback/search?q=x") as any, { params: Promise.resolve({ c: "feedback" }) });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_intent" });
    });
  });

  describe("PUT/DELETE on a file collection → 405", () => {
    it("PUT is not_writable", async () => {
      const { PUT } = await import("../app/v1/collections/[c]/documents/[id]/route");
      const res = await PUT(
        req("/v1/collections/documents/documents/00000000-0000-0000-0000-000000000000", { method: "PUT", body: { title: "x" } }) as any,
        { params: Promise.resolve({ c: "documents", id: "00000000-0000-0000-0000-000000000000" }) });
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "not_writable" });
    });

    it("DELETE is not_writable", async () => {
      const { DELETE } = await import("../app/v1/collections/[c]/documents/[id]/route");
      const res = await DELETE(
        req("/v1/collections/documents/documents/00000000-0000-0000-0000-000000000000", { method: "DELETE" }) as any,
        { params: Promise.resolve({ c: "documents", id: "00000000-0000-0000-0000-000000000000" }) });
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "not_writable" });
    });
  });

  describe("GET /v1/changes", () => {
    it("returns entries for the mutations made above", async () => {
      const { GET } = await import("../app/v1/changes/route");
      const res = await GET(req("/v1/changes?since=0") as any);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries.some((e: any) => e.collection === "feedback")).toBe(true);
    });
  });

  describe("proposals: mia proposes, marcus approves/rejects", () => {
    it("mia's create is pending (202), and appears in marcus's pending queue, then approves", async () => {
      const { POST } = await import("../app/v1/collections/[c]/documents/route");
      const createRes = await POST(
        req("/v1/collections/feedback/documents", { method: "POST", token: miaToken, body: { title: "Proposed", message: "please review", submitted_by: "mia" } }) as any,
        { params: Promise.resolve({ c: "feedback" }) });
      expect(createRes.status).toBe(202);
      const { proposalId } = await createRes.json();
      expect(proposalId).toBeDefined();

      const { GET: ListProposals } = await import("../app/v1/proposals/route");
      const listRes = await ListProposals(req("/v1/proposals?status=pending") as any);
      expect(listRes.status).toBe(200);
      const { proposals } = await listRes.json();
      expect(proposals.some((p: any) => p.proposalId === proposalId)).toBe(true);

      const { POST: Approve } = await import("../app/v1/proposals/[id]/approve/route");
      const approveRes = await Approve(req(`/v1/proposals/${proposalId}/approve`, { method: "POST" }) as any, { params: Promise.resolve({ id: proposalId }) });
      expect(approveRes.status).toBe(200);
    });

    it("mia's second proposal can be rejected by marcus", async () => {
      const { POST } = await import("../app/v1/collections/[c]/documents/route");
      const createRes = await POST(
        req("/v1/collections/feedback/documents", { method: "POST", token: miaToken, body: { title: "Reject me", message: "x", submitted_by: "mia" } }) as any,
        { params: Promise.resolve({ c: "feedback" }) });
      const { proposalId } = await createRes.json();

      const { POST: Reject } = await import("../app/v1/proposals/[id]/reject/route");
      const rejectRes = await Reject(req(`/v1/proposals/${proposalId}/reject`, { method: "POST" }) as any, { params: Promise.resolve({ id: proposalId }) });
      expect(rejectRes.status).toBe(200);
    });
  });

  describe("GET/POST /v1/grants", () => {
    it("GET returns the caller's own grants, scoped to marcus", async () => {
      const { GET } = await import("../app/v1/grants/route");
      const res = await GET(req("/v1/grants") as any);
      expect(res.status).toBe(200);
      const { grants } = await res.json();
      expect(grants.length).toBeGreaterThan(0);
      expect(grants.every((g: any) => g.user_id === "marcus")).toBe(true);
    });

    it("POST requests a new grant → 201", async () => {
      const { POST } = await import("../app/v1/grants/route");
      const res = await POST(req("/v1/grants", {
        method: "POST", body: { collection: "documents", purposeLabel: "read policies", fields: ["title", "content"] },
      }) as any);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.requestId).toBeDefined();
    });
  });

  describe("refusal body never leaks the submitted field name or value", () => {
    it("an update naming a non-writable field and a distinctive value is refused with only { error }", async () => {
      const { POST } = await import("../app/v1/collections/[c]/documents/route");
      const distinctiveValue = "top-secret-marker-9f3a";
      const res = await POST(
        req("/v1/collections/feedback/documents", {
          method: "POST",
          body: { title: "x", message: "y", submitted_by: "z", nonexistent_field: distinctiveValue },
        }) as any,
        { params: Promise.resolve({ c: "feedback" }) });
      const raw = await res.text();
      expect(raw).not.toContain("nonexistent_field");
      expect(raw).not.toContain(distinctiveValue);
      expect(JSON.parse(raw)).toEqual({ error: expect.any(String) });
      expect(Object.keys(JSON.parse(raw))).toEqual(["error"]);
    });
  });
});
