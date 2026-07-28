import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TOOLS, toolByName } from "../lib/mcp-tools";
import { setupWebDb } from "./helpers/web-db";

let db: Awaited<ReturnType<typeof setupWebDb>>;
const ctx = { userId: "mia", orgId: "default", env: "dev" as const };

beforeAll(async () => {
  db = await setupWebDb("mcpwritetools");
}, 60_000);
afterAll(async () => { await db?.end(); });

describe("mcp-tools: no approve/reject tools exist", () => {
  it("does not have approve or reject in TOOLS", () => {
    const hasApproveReject = TOOLS.some((t) => /approve|reject/i.test(t.name));
    expect(hasApproveReject).toBe(false);
  });
});

describe("mcp-tools: get_document", () => {
  it("is registered with collection required", () => {
    const tool = toolByName("get_document");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(["collection"]);
  });

  it("rejects missing id and path with invalid_intent", async () => {
    const tool = toolByName("get_document")!;
    const out = await tool.handler(ctx, { collection: "people" }) as { ok: boolean; reason: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("invalid_intent");
  });

  it("rejects unknown collection with a hint", async () => {
    const tool = toolByName("get_document")!;
    const out = await tool.handler(ctx, { collection: "does_not_exist", id: "x" }) as { ok: boolean; hint?: string };
    expect(out.ok).toBe(false);
    expect(out.hint).toContain("request_access");
  });

  it("rejects no_grant with a hint", async () => {
    const tool = toolByName("get_document")!;
    const out = await tool.handler(ctx, { collection: "salaries", id: "x" }) as { ok: boolean; hint?: string };
    expect(out.ok).toBe(false);
    expect(out.hint).toContain("request_access");
  });
});

describe("mcp-tools: create_document", () => {
  it("is registered with collection and values required", () => {
    const tool = toolByName("create_document");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(["collection", "values"]);
  });

  it("rejects unknown collection with a hint", async () => {
    const tool = toolByName("create_document")!;
    const out = await tool.handler(ctx, { collection: "does_not_exist", values: {} }) as { ok: boolean; hint?: string };
    expect(out.ok).toBe(false);
    expect(out.hint).toContain("request_access");
  });

  it("rejects no_grant with a hint", async () => {
    const tool = toolByName("create_document")!;
    const out = await tool.handler(ctx, { collection: "people", values: { name: "test" } }) as { ok: boolean; hint?: string };
    expect(out.ok).toBe(false);
    expect(out.hint).toContain("request_access");
  });

  it("wraps refusals with withHint so create responses always contain hint on no_grant", async () => {
    const tool = toolByName("create_document")!;
    const out = await tool.handler(ctx, { collection: "people", values: { name: "test" } }) as { ok: boolean; reason?: string; hint?: string };
    expect(out.ok).toBe(false);
    // Likely no_grant since no grant was set up
    expect(out.hint).toContain("request_access");
  });
});

describe("mcp-tools: update_document", () => {
  it("is registered with collection, id, values required", () => {
    const tool = toolByName("update_document");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(["collection", "id", "values"]);
  });

  it("rejects unknown collection with a hint", async () => {
    const tool = toolByName("update_document")!;
    const out = await tool.handler(ctx, { collection: "does_not_exist", id: "x", values: {} }) as { ok: boolean; hint?: string };
    expect(out.ok).toBe(false);
    expect(out.hint).toContain("request_access");
  });

  it("wraps refusals with withHint so update responses always contain hint on no_grant", async () => {
    const tool = toolByName("update_document")!;
    const out = await tool.handler(ctx, { collection: "feedback", id: "x", values: { title: "updated" } }) as { ok: boolean; reason?: string; hint?: string };
    expect(out.ok).toBe(false);
    // Should get no_grant since no grant was set up
    expect(out.hint).toContain("request_access");
  });
});

describe("mcp-tools: delete_document", () => {
  it("is registered with collection and id required", () => {
    const tool = toolByName("delete_document");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required).toEqual(["collection", "id"]);
  });

  it("rejects unknown collection with a hint", async () => {
    const tool = toolByName("delete_document")!;
    const out = await tool.handler(ctx, { collection: "does_not_exist", id: "x" }) as { ok: boolean; hint?: string };
    expect(out.ok).toBe(false);
    expect(out.hint).toContain("request_access");
  });

  it("rejects no_grant with a hint", async () => {
    const tool = toolByName("delete_document")!;
    const out = await tool.handler(ctx, { collection: "people", id: "x" }) as { ok: boolean; hint?: string };
    expect(out.ok).toBe(false);
    expect(out.hint).toContain("request_access");
  });
});

