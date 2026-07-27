import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TOOLS, toolByName } from "../lib/mcp-tools";
import { setupWebDb } from "./helpers/web-db";

let db: Awaited<ReturnType<typeof setupWebDb>>;
const ctx = { userId: "mia", env: "dev" as const };

beforeAll(async () => {
  db = await setupWebDb("mcptools");
}, 60_000);
afterAll(async () => { await db?.end(); });

describe("mcp-tools: list_collections", () => {
  it("is registered with an empty-object input schema", () => {
    const tool = toolByName("list_collections");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("delegates to broker.listCollections", async () => {
    const tool = toolByName("list_collections")!;
    const out = await tool.handler(ctx, {});
    expect(Array.isArray(out)).toBe(true);
  });
});

describe("mcp-tools: describe_collection", () => {
  it("is registered with a required name field", () => {
    const tool = toolByName("describe_collection");
    expect(tool!.inputSchema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
  });

  it("adds a request_access hint to a no_grant refusal", async () => {
    const tool = toolByName("describe_collection")!;
    const out = await tool.handler(ctx, { name: "does_not_exist" }) as { ok: boolean; reason: string; hint?: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("unknown_collection");
    expect(out.hint).toContain("request_access");
  });
});

describe("mcp-tools: query_collection", () => {
  it("is registered and rejects unknown collections with a hint", async () => {
    const tool = toolByName("query_collection")!;
    expect(tool.inputSchema.required).toEqual(["collection"]);
    const out = await tool.handler(ctx, { collection: "does_not_exist" }) as { ok: boolean; reason: string; hint?: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("unknown_collection");
    expect(out.hint).toContain("request_access");
  });
});

describe("mcp-tools: search_documents", () => {
  it("is registered with collection and q required", () => {
    const tool = toolByName("search_documents")!;
    expect(tool.inputSchema.required).toEqual(["collection", "q"]);
  });

  it("rejects unknown collections with a hint", async () => {
    const tool = toolByName("search_documents")!;
    const out = await tool.handler(ctx, { collection: "does_not_exist", q: "x" }) as { ok: boolean; hint?: string };
    expect(out.ok).toBe(false);
    expect(out.hint).toContain("request_access");
  });
});

describe("DATA_TOOL_NAMES", () => {
  it("matches the query/search tool names", async () => {
    const { DATA_TOOL_NAMES } = await import("../lib/mcp-tools");
    expect(DATA_TOOL_NAMES).toEqual(["query_collection", "search_documents"]);
  });
});

describe("mcp-tools: request_access", () => {
  it("is registered with collection and purpose required, fields optional", () => {
    const tool = toolByName("request_access")!;
    expect(tool.inputSchema.required).toEqual(["collection", "purpose"]);
  });

  it("creates a pending grant row via requestGrant and returns its id", async () => {
    const tool = toolByName("request_access")!;
    const out = await tool.handler(ctx, {
      collection: "people", purpose: "quarterly headcount review", fields: ["id", "department_name"],
    }) as { ok: boolean; requestId: string };
    expect(out.ok).toBe(true);
    expect(out.requestId).toBeTruthy();

    const { getAppPool } = await import("../app/lib/broker");
    const row = await getAppPool().query(
      `select status, user_id, collection, env, allowed_fields from app.grants where id = $1`,
      [out.requestId],
    );
    expect(row.rows[0]).toMatchObject({
      status: "pending", user_id: "mia", collection: "people", env: "dev",
      allowed_fields: ["id", "department_name"],
    });
  });

  it("rejects an unknown collection with a hint and creates no row", async () => {
    const tool = toolByName("request_access")!;
    const out = await tool.handler(ctx, {
      collection: "does_not_exist", purpose: "test",
    }) as { ok: boolean; reason: string; hint?: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("unknown_collection");
    expect(out.hint).toContain("request_access");

    const { getAppPool } = await import("../app/lib/broker");
    const row = await getAppPool().query(
      `select * from app.grants where collection = $1 and user_id = $2`,
      ["does_not_exist", "mia"],
    );
    expect(row.rows).toHaveLength(0);
  });

  it("rejects an empty purpose with a hint and creates no row", async () => {
    const tool = toolByName("request_access")!;
    const out = await tool.handler(ctx, {
      collection: "people", purpose: "",
    }) as { ok: boolean; reason: string; hint?: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("purpose_required");
    expect(out.hint).toContain("request_access");

    const { getAppPool } = await import("../app/lib/broker");
    const row = await getAppPool().query(
      `select * from app.grants where collection = $1 and user_id = $2 and status = 'pending'`,
      ["people", "mia"],
    );
    expect(row.rows.filter((r: any) => !r.purpose_label || !r.purpose_label.trim())).toHaveLength(0);
  });

  it("rejects a posture:deny field with a hint and creates no row", async () => {
    const tool = toolByName("request_access")!;
    const out = await tool.handler(ctx, {
      collection: "salaries", purpose: "compensation review", fields: ["id", "ssn"],
    }) as { ok: boolean; reason: string; hint?: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("field_not_grantable");
    expect(out.hint).toContain("request_access");

    const { getAppPool } = await import("../app/lib/broker");
    const row = await getAppPool().query(
      `select * from app.grants where collection = $1 and user_id = $2 and status = 'pending'`,
      ["salaries", "mia"],
    );
    // Filter out any rows that include ssn — they should be none because the request was rejected
    const rowsWithSsn = row.rows.filter((r: any) => r.allowed_fields && r.allowed_fields.includes("ssn"));
    expect(rowsWithSsn).toHaveLength(0);
  });
});

describe("TOOLS", () => {
  it("names are unique", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
