import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { approveGrant, requestGrant, loadConfig, type WarehousdConfig } from "@warehousd/broker";
import { withStack, bearer, mintHeadlessToken, type Stack } from "./helpers/stack";
import { getAppPool } from "../app/lib/broker";

const harborDir = new URL("../../../examples/harbor", import.meta.url).pathname;
const harborCfg: WarehousdConfig = loadConfig(harborDir);

// End to end through POST /v1/collections/{c}/query's own route handler: `after`/`nextCursor`
// as they survive QueryIntentSchema.safeParse({ ...body, collection: c }) and travel over the
// REST envelope, which packages/broker/test/keyset-pagination.test.ts (calling broker.query()
// directly) cannot pin — a route change that stops forwarding `after` would still pass every
// broker test.
describe("POST /v1/collections/{c}/query — keyset pagination over HTTP", () => {
  let stack: Stack;
  let walkerToken: string;

  beforeAll(async () => {
    stack = await withStack("keysetpage");
    const app = getAppPool();

    // "clients" (examples/harbor/warehousd.yml): 150 synthetic documents, a declared pk (`id`)
    // and a dense, unique text field (`client_number`) to sort and page on — enough documents
    // for several pages at a small limit, with a 150 that does not divide evenly by the limit
    // below so the final page is genuinely short.
    const walkerGrant = await requestGrant(app, {
      userId: "marcus",
      collection: "clients",
      workspaceId: "default",
      env: "dev",
      purposeLabel: "test",
      allowedFields: ["id", "client_number", "name", "industry", "status"],
    });
    await approveGrant(app, harborCfg, walkerGrant, "admin", { verbs: ["read"] });

    walkerToken = await mintHeadlessToken(stack.db, "Walker Client", "marcus");
  }, 60_000);

  afterAll(async () => {
    await stack?.end();
  });

  function queryReq(body: unknown, token: string) {
    return new Request("http://localhost:8722/v1/collections/clients/query", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify(body),
    });
  }

  async function postQuery(body: unknown, token: string = walkerToken) {
    const { POST } = await import("../app/v1/collections/[c]/query/route");
    return POST(queryReq(body, token) as any, { params: Promise.resolve({ c: "clients" }) });
  }

  it("walks the whole collection exactly once, following `after`/`nextCursor` alone", async () => {
    const expected = await stack.admin.query(`select id from data_synth.clients`);
    const expectedIds = new Set(expected.rows.map((r) => r.id as string));
    expect(expectedIds.size).toBeGreaterThan(20); // enough for several pages of 20

    const seenIds: string[] = [];
    let after: string | undefined;
    let pageCount = 0;
    const pageLengths: number[] = [];
    for (;;) {
      pageCount++;
      if (pageCount > 100) throw new Error("walk did not terminate");
      const res = await postQuery({
        fields: ["id"],
        orderBy: { field: "client_number", dir: "asc" },
        limit: 20,
        ...(after !== undefined ? { after } : {}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      for (const doc of body.documents) seenIds.push(doc.id);
      pageLengths.push(body.documents.length);
      if (body.nextCursor === undefined) break;
      after = body.nextCursor;
    }

    // Every document appeared exactly once, and the union equals the whole collection.
    expect(seenIds.length).toBe(expectedIds.size);
    expect(new Set(seenIds).size).toBe(expectedIds.size);
    expect(new Set(seenIds)).toEqual(expectedIds);
    // 150 documents at a limit of 20 does not divide evenly, so the last page is short — the
    // absence of `nextCursor` on it is how a caller learns the walk ended, not a fluke of an
    // exact multiple.
    const lastPageLength = pageLengths[pageLengths.length - 1] ?? 0;
    expect(lastPageLength).toBeGreaterThan(0);
    expect(lastPageLength).toBeLessThan(20);
    expect(pageCount).toBeGreaterThan(1);
    // Every page before the last came back full — a short page anywhere earlier would mean the
    // cursor had skipped documents rather than reached the end.
    expect(pageLengths.slice(0, -1).every((n) => n === 20)).toBe(true);
  });

  it("a garbage `after` string → 400 invalid_intent", async () => {
    const res = await postQuery({
      fields: ["id"],
      orderBy: { field: "client_number", dir: "asc" },
      limit: 5,
      after: "%%% not a cursor %%%",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_intent" });
  });

  it("`after` together with `offset` → 400 invalid_intent", async () => {
    const res = await postQuery({
      fields: ["id"],
      orderBy: { field: "client_number", dir: "asc" },
      limit: 5,
      offset: 1,
      after: "anything",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_intent" });
  });

  it("a narrow `fields` projection returns exactly the fields it named while paginating — never the internally-read sort field or pk", async () => {
    let after: string | undefined;
    let pages = 0;
    let sawAny = false;
    for (let i = 0; i < 3; i++) {
      const res = await postQuery({
        fields: ["name", "industry"],
        orderBy: { field: "client_number", dir: "asc" },
        limit: 5,
        ...(after !== undefined ? { after } : {}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      pages++;
      for (const doc of body.documents) {
        sawAny = true;
        expect(Object.keys(doc).sort()).toEqual(["industry", "name"]);
        expect("id" in doc).toBe(false);
        expect("client_number" in doc).toBe(false);
      }
      if (body.nextCursor === undefined) break;
      after = body.nextCursor;
    }
    expect(sawAny).toBe(true);
    expect(pages).toBeGreaterThan(1);
  });
});
