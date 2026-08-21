import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { requestGrant, approveGrant, loadConfig, type WarehousdConfig } from "@warehousd/broker";
import { withStack, bearer, mintHeadlessToken, type Stack } from "./helpers/stack";
import { getAppPool } from "../app/lib/broker";

const harborDir = new URL("../../../examples/harbor", import.meta.url).pathname;
const harborCfg: WarehousdConfig = loadConfig(harborDir);

// End to end through the /v1 revision route handlers themselves — packages/broker/test's
// revision-read.test.ts (calling broker.getRevision/diffRevisions directly) cannot pin the REST
// adapter: a route change that stops forwarding `from`/`to`, or that names the wrong response
// schema, would still pass every broker test.
//
// harbor's only writable collection is `matter_tasks` (examples/harbor/warehousd.yml), so it is
// the only collection revision history exists for here. Two revisions are produced through the
// real write path — create, then update — rather than inserted directly, so the seed itself
// exercises the same `broker.mutate` the fixture is meant to stand in for.
describe("revision REST endpoints", () => {
  let stack: Stack;
  let token: string;
  let docId: string;
  let revId: string;
  let revId2: string;

  beforeAll(async () => {
    stack = await withStack("revisionroutes");
    const app = getAppPool();

    const grantId = await requestGrant(app, {
      userId: "marcus",
      collection: "matter_tasks",
      env: "dev",
      purposeLabel: "test",
      allowedFields: ["id", "title", "notes", "assignee", "created_at"],
    });
    await approveGrant(app, harborCfg, grantId, "admin", {
      verbs: ["read", "create", "update"],
      mode: "direct",
    });

    token = await mintHeadlessToken(stack.db, "Revision Routes Client", "marcus");

    const { POST: createDoc } = await import("../app/v1/collections/[c]/documents/route");
    const createRes = await createDoc(
      new Request("http://localhost:8722/v1/collections/matter_tasks/documents", {
        method: "POST",
        headers: { "content-type": "application/json", ...bearer(token) },
        body: JSON.stringify({ title: "Draft brief", notes: "first pass", assignee: "walker" }),
      }) as any,
      { params: Promise.resolve({ c: "matter_tasks" }) },
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    docId = created.documentId;
    revId = created.rev;

    const { PUT: updateDoc } = await import("../app/v1/collections/[c]/documents/[id]/route");
    const updateRes = await updateDoc(
      new Request(`http://localhost:8722/v1/collections/matter_tasks/documents/${docId}`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...bearer(token) },
        body: JSON.stringify({ notes: "revised", assignee: "walker" }),
      }) as any,
      { params: Promise.resolve({ c: "matter_tasks", id: docId }) },
    );
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    revId2 = updated.rev;
  }, 60_000);

  afterAll(async () => {
    await stack?.end();
  });

  it("GET /v1/collections/{c}/documents/{id}/revisions/{rev} returns the projected document", async () => {
    const { GET } = await import("../app/v1/collections/[c]/documents/[id]/revisions/[rev]/route");
    const res = await GET(
      new Request(
        `http://localhost:8722/v1/collections/matter_tasks/documents/${docId}/revisions/${revId}`,
        { headers: bearer(token) },
      ) as any,
      { params: Promise.resolve({ c: "matter_tasks", id: docId, rev: revId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.revision.rev).toBe(revId);
    expect(typeof body.revision.seq).toBe("number");
    expect(body.revision.document).toBeTypeOf("object");
    expect(Array.isArray(body.fieldsReturned)).toBe(true);
  });

  it("returns 404 for a revision that does not belong to the document", async () => {
    const { GET } = await import("../app/v1/collections/[c]/documents/[id]/revisions/[rev]/route");
    const res = await GET(
      new Request(
        `http://localhost:8722/v1/collections/matter_tasks/documents/${docId}/revisions/00000000-0000-4000-8000-000000000000`,
        { headers: bearer(token) },
      ) as any,
      {
        params: Promise.resolve({
          c: "matter_tasks",
          id: docId,
          rev: "00000000-0000-4000-8000-000000000000",
        }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("GET .../revisions/diff?from=&to= returns the field changes", async () => {
    const { GET } = await import("../app/v1/collections/[c]/documents/[id]/revisions/diff/route");
    const res = await GET(
      new Request(
        `http://localhost:8722/v1/collections/matter_tasks/documents/${docId}/revisions/diff?from=${revId}&to=${revId2}`,
        { headers: bearer(token) },
      ) as any,
      { params: Promise.resolve({ c: "matter_tasks", id: docId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.changes)).toBe(true);
    expect(
      body.changes.every((c: unknown) => typeof (c as { field: string }).field === "string"),
    ).toBe(true);
  });

  it("returns 400 when from or to is missing", async () => {
    const { GET } = await import("../app/v1/collections/[c]/documents/[id]/revisions/diff/route");
    const res = await GET(
      new Request(
        `http://localhost:8722/v1/collections/matter_tasks/documents/${docId}/revisions/diff?from=${revId}`,
        { headers: bearer(token) },
      ) as any,
      { params: Promise.resolve({ c: "matter_tasks", id: docId }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 401 without a bearer token", async () => {
    const { GET } = await import("../app/v1/collections/[c]/documents/[id]/revisions/[rev]/route");
    const res = await GET(
      new Request(
        `http://localhost:8722/v1/collections/matter_tasks/documents/${docId}/revisions/${revId}`,
      ) as any,
      { params: Promise.resolve({ c: "matter_tasks", id: docId, rev: revId }) },
    );
    expect(res.status).toBe(401);
  });
  // Revert, through the route rather than the verb. The 200/202/204 mapping is the route's own
  // (lib/rest.ts `mutationStatus`), and the broker cannot pin it: `revertDocument` returns a
  // status string, and a route that mapped `noop` to 200 with a body would still pass every
  // broker test while telling a client something untrue.
  it("POST .../revisions/{rev}/revert appends a revision and answers 200", async () => {
    const { POST } =
      await import("../app/v1/collections/[c]/documents/[id]/revisions/[rev]/revert/route");
    const res = await POST(
      new Request(
        `http://localhost:8722/v1/collections/matter_tasks/documents/${docId}/revisions/${revId}/revert`,
        { method: "POST", headers: bearer(token) },
      ) as any,
      { params: Promise.resolve({ c: "matter_tasks", id: docId, rev: revId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("applied");
    // Appended, never rewound: the document now has three revisions, not two.
    const { GET: listRevisions } =
      await import("../app/v1/collections/[c]/documents/[id]/revisions/route");
    const listed = await listRevisions(
      new Request(
        `http://localhost:8722/v1/collections/matter_tasks/documents/${docId}/revisions`,
        { headers: bearer(token) },
      ) as any,
      { params: Promise.resolve({ c: "matter_tasks", id: docId }) },
    );
    expect((await listed.json()).revisions.length).toBe(3);
  });

  it("reverting to the revision the document is already at answers 204 with no body", async () => {
    const { POST } =
      await import("../app/v1/collections/[c]/documents/[id]/revisions/[rev]/revert/route");
    // The previous test just reverted to revId, so the current state already IS revId's.
    const res = await POST(
      new Request(
        `http://localhost:8722/v1/collections/matter_tasks/documents/${docId}/revisions/${revId}/revert`,
        { method: "POST", headers: bearer(token) },
      ) as any,
      { params: Promise.resolve({ c: "matter_tasks", id: docId, rev: revId }) },
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("revert returns 401 without a bearer token", async () => {
    const { POST } =
      await import("../app/v1/collections/[c]/documents/[id]/revisions/[rev]/revert/route");
    const res = await POST(
      new Request(
        `http://localhost:8722/v1/collections/matter_tasks/documents/${docId}/revisions/${revId2}/revert`,
        { method: "POST" },
      ) as any,
      { params: Promise.resolve({ c: "matter_tasks", id: docId, rev: revId2 }) },
    );
    expect(res.status).toBe(401);
  });
});
