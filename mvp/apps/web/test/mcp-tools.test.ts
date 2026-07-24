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

describe("TOOLS", () => {
  it("names are unique", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
