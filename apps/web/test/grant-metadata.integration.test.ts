import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { setupWebDbWithData, signIn } from "./helpers/web-db";

// The two endpoints that feed the grant-authoring UI: the file list a manager picks paths from,
// and the vocabularies they pick terms from. Neither had a test.
//
// They are worth one because of what they answer to whom. Both are gated at `manager`, and both
// describe a collection's contents to someone who may hold no grant on it at all — doc-paths
// returns real filenames, terms returns the vocabulary a collection is classified by. A guard
// that regressed here would not fail loudly; it would just start answering members.
let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let anaCookie: string, marcusCookie: string, miaCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("grantmeta");
  anaCookie = await signIn(db.auth, "ana@harbor.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@harbor.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@harbor.demo", "demo");
}, 60_000);
afterAll(async () => {
  await db?.end();
});

// A real NextRequest, not a plain Request: these two routes read `req.nextUrl`, which only
// NextRequest carries. Every other route in the app reads `new URL(req.url)` and so is drivable
// from a bare Request — which is most of the reason these two ended up with no tests at all.
function req(path: string, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  return new NextRequest(`http://localhost:8722${path}`, { headers });
}

describe("GET /api/grants/doc-paths", () => {
  it("401s without a session", async () => {
    const { GET } = await import("../app/api/grants/doc-paths/route");
    const res = await GET(req("/api/grants/doc-paths?collection=policies&env=dev"));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthenticated");
  });

  // The one that matters: a member must not be able to enumerate a collection's files by asking
  // the grant-authoring endpoint instead of the data path.
  it("403s a member", async () => {
    const { GET } = await import("../app/api/grants/doc-paths/route");
    const res = await GET(req("/api/grants/doc-paths?collection=policies&env=dev", miaCookie));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden");
  });

  it("lists the paths of a file collection for a manager", async () => {
    const { GET } = await import("../app/api/grants/doc-paths/route");
    const res = await GET(req("/api/grants/doc-paths?collection=policies&env=dev", marcusCookie));
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).paths)).toBe(true);
  });

  it("admits an admin too, since manager is a floor and not an equality", async () => {
    const { GET } = await import("../app/api/grants/doc-paths/route");
    const res = await GET(req("/api/grants/doc-paths?collection=policies&env=dev", anaCookie));
    expect(res.status).toBe(200);
  });

  // `env` here selects which environment's file list to show — it is a real parameter, not a
  // BrokerContext env — so it is validated rather than defaulted: guessing dev for a malformed
  // value would show synthetic files to someone who asked about live.
  it("400s on a missing env", async () => {
    const { GET } = await import("../app/api/grants/doc-paths/route");
    const res = await GET(req("/api/grants/doc-paths?collection=policies", marcusCookie));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_env");
  });

  it("400s on an env that is neither dev nor live", async () => {
    const { GET } = await import("../app/api/grants/doc-paths/route");
    const res = await GET(
      req("/api/grants/doc-paths?collection=policies&env=staging", marcusCookie),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_env");
  });

  // A collection that is not a file collection has no paths to list, and the lookup throws. The
  // route has to turn that into a 400 rather than let a driver error surface as a 500.
  it("400s unavailable rather than throwing for a collection with no file source", async () => {
    const { GET } = await import("../app/api/grants/doc-paths/route");
    const res = await GET(
      req("/api/grants/doc-paths?collection=nonexistent&env=dev", marcusCookie),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unavailable");
  });
});

describe("GET /api/grants/terms", () => {
  it("401s without a session", async () => {
    const { GET } = await import("../app/api/grants/terms/route");
    const res = await GET(req("/api/grants/terms?collection=policies"));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthenticated");
  });

  it("403s a member", async () => {
    const { GET } = await import("../app/api/grants/terms/route");
    const res = await GET(req("/api/grants/terms?collection=policies", miaCookie));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden");
  });

  it("returns both vocabularies a collection is bound to", async () => {
    const { GET } = await import("../app/api/grants/terms/route");
    const res = await GET(req("/api/grants/terms?collection=policies", marcusCookie));
    expect(res.status).toBe(200);
    const fields = (await res.json()).vocabularies.map((v: { field: string }) => v.field);
    expect(fields).toContain("department");
    expect(fields).toContain("tags");
  });

  // `multiple: true` on tags and not on department is the difference between a checkbox list and a
  // radio group in the UI, so it has to survive the trip.
  it("reports which vocabularies accept more than one term", async () => {
    const { GET } = await import("../app/api/grants/terms/route");
    const res = await GET(req("/api/grants/terms?collection=policies", marcusCookie));
    const vocabs = (await res.json()).vocabularies as { field: string; multiple: boolean }[];
    expect(vocabs.find((v) => v.field === "tags")?.multiple).toBe(true);
    expect(vocabs.find((v) => v.field === "department")?.multiple).toBeFalsy();
  });

  // Empty, not an error: a collection with no taxonomies is an ordinary collection, and the UI
  // renders no term picker for it.
  it("returns an empty list for a collection with no taxonomies", async () => {
    const { GET } = await import("../app/api/grants/terms/route");
    const res = await GET(req("/api/grants/terms?collection=people", marcusCookie));
    expect(res.status).toBe(200);
    expect((await res.json()).vocabularies).toEqual([]);
  });

  it("returns an empty list rather than 404 for a collection that does not exist", async () => {
    const { GET } = await import("../app/api/grants/terms/route");
    const res = await GET(req("/api/grants/terms?collection=nosuchthing", marcusCookie));
    expect(res.status).toBe(200);
    expect((await res.json()).vocabularies).toEqual([]);
  });

  it("returns an empty list when no collection is named at all", async () => {
    const { GET } = await import("../app/api/grants/terms/route");
    const res = await GET(req("/api/grants/terms", marcusCookie));
    expect(res.status).toBe(200);
    expect((await res.json()).vocabularies).toEqual([]);
  });
});
