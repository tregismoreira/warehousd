import { describe, test, expect } from "vitest";
import * as collectionsRoute from "../app/v1/collections/route";
import * as collectionDetailRoute from "../app/v1/collections/[c]/route";
import * as queryRoute from "../app/v1/collections/[c]/query/route";
import * as searchRoute from "../app/v1/collections/[c]/search/route";
import * as documentsRoute from "../app/v1/collections/[c]/documents/route";
import * as documentDetailRoute from "../app/v1/collections/[c]/documents/[id]/route";
import * as revisionsRoute from "../app/v1/collections/[c]/documents/[id]/revisions/route";
import * as aclRoute from "../app/v1/collections/[c]/documents/[id]/acl/route";
import * as changesRoute from "../app/v1/changes/route";
import * as proposalsRoute from "../app/v1/proposals/route";
import * as approveRoute from "../app/v1/proposals/[id]/approve/route";
import * as rejectRoute from "../app/v1/proposals/[id]/reject/route";
import * as decideRoute from "../app/v1/proposals/decide/route";
import * as grantsRoute from "../app/v1/grants/route";

describe("REST routes: handler exports", () => {
  test("GET /v1/collections exports GET", () => {
    expect(typeof collectionsRoute.GET).toBe("function");
  });

  test("GET /v1/collections/{c} exports GET", () => {
    expect(typeof collectionDetailRoute.GET).toBe("function");
  });

  test("POST /v1/collections/{c}/query exports POST", () => {
    expect(typeof queryRoute.POST).toBe("function");
  });

  test("GET /v1/collections/{c}/search exports GET", () => {
    expect(typeof searchRoute.GET).toBe("function");
  });

  test("POST /v1/collections/{c}/documents exports POST", () => {
    expect(typeof documentsRoute.POST).toBe("function");
  });

  test("GET /v1/collections/{c}/documents/{id} exports GET, PUT, DELETE", () => {
    expect(typeof documentDetailRoute.GET).toBe("function");
    expect(typeof documentDetailRoute.PUT).toBe("function");
    expect(typeof documentDetailRoute.DELETE).toBe("function");
  });

  test("GET /v1/collections/{c}/documents/{id}/revisions exports GET", () => {
    expect(typeof revisionsRoute.GET).toBe("function");
  });

  test("GET /v1/collections/{c}/documents/{id}/acl exports GET, PUT, DELETE", () => {
    expect(typeof aclRoute.GET).toBe("function");
    expect(typeof aclRoute.PUT).toBe("function");
    expect(typeof aclRoute.DELETE).toBe("function");
  });

  test("GET /v1/changes exports GET", () => {
    expect(typeof changesRoute.GET).toBe("function");
  });

  test("GET /v1/proposals exports GET", () => {
    expect(typeof proposalsRoute.GET).toBe("function");
  });

  test("POST /v1/proposals/{id}/approve exports POST", () => {
    expect(typeof approveRoute.POST).toBe("function");
  });

  test("POST /v1/proposals/{id}/reject exports POST", () => {
    expect(typeof rejectRoute.POST).toBe("function");
  });

  test("POST /v1/proposals/decide exports POST", () => {
    expect(typeof decideRoute.POST).toBe("function");
  });

  test("GET /v1/grants exports GET, POST /v1/grants exports POST", () => {
    expect(typeof grantsRoute.GET).toBe("function");
    expect(typeof grantsRoute.POST).toBe("function");
  });
});

describe("REST routes: 401 unauthenticated", () => {
  // These test that deriveRestContext returning null produces 401.
  // Full end-to-end integration testing happens in Task 8.5.

  test("GET /v1/collections returns 401 when unauthenticated", async () => {
    const req = new Request("http://localhost:3000/v1/collections", { method: "GET" });
    // No authentication headers
    const response = await collectionsRoute.GET(req as any);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("unauthenticated");
  });

  test("GET /v1/changes returns 401 when unauthenticated", async () => {
    const req = new Request("http://localhost:3000/v1/changes", { method: "GET" });
    const response = await changesRoute.GET(req as any);
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("unauthenticated");
  });

  test("POST /v1/collections/{c}/query returns 401 when unauthenticated", async () => {
    const req = new Request("http://localhost:3000/v1/collections/test/query", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const params = Promise.resolve({ c: "test" });
    const response = await queryRoute.POST(req as any, { params });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("unauthenticated");
  });
});
