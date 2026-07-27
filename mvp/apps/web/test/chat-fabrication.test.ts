import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { setupWebDbWithData } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";
import { looksFabricated, collectQueriedOk } from "../lib/chat-fabrication";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
const ctx = { userId: "mia", env: "dev" as const };

beforeAll(async () => {
  db = await setupWebDbWithData("chatfab");
}, 60_000);
afterAll(async () => { await db?.end(); });

describe("collectQueriedOk", () => {
  it("returns empty set when no successful queries in conversation", () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: "what data do we have?",
      },
    ];
    const result = collectQueriedOk(messages);
    expect(result).toEqual(new Set());
  });

  it("extracts collection name from successful query_collection tool call", async () => {
    const { toolByName } = await import("../lib/mcp-tools");

    // Seed an approved grant for mia on people collection
    const pool = getAppPool();
    await pool.query(`delete from app.grants where user_id=$1 and collection=$2 and env=$3`, ["mia", "people", "dev"]);
    await pool.query(
      `insert into app.grants (user_id, collection, allowed_fields, env, status)
       values ($1, $2, $3, $4, $5)`,
      ["mia", "people", ["id", "full_name", "email", "department_name", "department_id"], "dev", "approved"]
    );

    const tool = toolByName("query_collection")!;
    const result = await tool.handler(ctx, { collection: "people" });
    const toolResultContent = JSON.stringify(result);

    const messages: Anthropic.MessageParam[] = [
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "call_1",
          name: "query_collection",
          input: { collection: "people" },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_1",
          content: toolResultContent,
        }],
      },
    ];
    const extracted = collectQueriedOk(messages);
    expect(extracted).toEqual(new Set(["people"]));
  });

  it("returns empty set when query_collection fails with ok:false", () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "call_1",
          name: "query_collection",
          input: { collection: "people" },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_1",
          content: JSON.stringify({ ok: false, reason: "no_grant" }),
        }],
      },
    ];
    const result = collectQueriedOk(messages);
    expect(result).toEqual(new Set());
  });

  it("collects multiple successfully queried collections across turns", async () => {
    const { toolByName } = await import("../lib/mcp-tools");

    // Seed approved grants for mia on both people and departments
    const pool = getAppPool();
    await pool.query(`delete from app.grants where user_id=$1 and env=$2`, ["mia", "dev"]);
    await pool.query(
      `insert into app.grants (user_id, collection, allowed_fields, env, status)
       values ($1, $2, $3, $4, $5)`,
      ["mia", "people", ["id", "full_name", "email", "department_name", "department_id"], "dev", "approved"]
    );
    await pool.query(
      `insert into app.grants (user_id, collection, allowed_fields, env, status)
       values ($1, $2, $3, $4, $5)`,
      ["mia", "departments", ["id", "name"], "dev", "approved"]
    );

    const tool = toolByName("query_collection")!;
    const peopleResult = await tool.handler(ctx, { collection: "people" });
    const departmentsResult = await tool.handler(ctx, { collection: "departments" });

    const messages: Anthropic.MessageParam[] = [
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "call_1",
          name: "query_collection",
          input: { collection: "people" },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_1",
          content: JSON.stringify(peopleResult),
        }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "some response" }],
      },
      {
        role: "user",
        content: "follow-up question",
      },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "call_2",
          name: "query_collection",
          input: { collection: "departments" },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_2",
          content: JSON.stringify(departmentsResult),
        }],
      },
    ];
    const result = collectQueriedOk(messages);
    expect(result).toEqual(new Set(["people", "departments"]));
  });
});

describe("looksFabricated", () => {
  it("detects markdown tables when no collections queried", () => {
    const text = "| a | b |\n|---|---|\n| 1 | 2 |";
    expect(looksFabricated(text, new Set())).toBe(true);
  });

  it("allows markdown tables when collections were queried", () => {
    const text = "| a | b |\n|---|---|\n| 1 | 2 |";
    expect(looksFabricated(text, new Set(["people"]))).toBe(false);
  });

  it("detects repeated dollar figures when no collections queried", () => {
    const text = "The budget is $1,000 and the reserve is $2,000.";
    expect(looksFabricated(text, new Set())).toBe(true);
  });

  it("allows repeated dollar figures when collections were queried", () => {
    const text = "The budget is $1,000 and the reserve is $2,000.";
    expect(looksFabricated(text, new Set(["salaries"]))).toBe(false);
  });

  it("ignores single dollar figure without collections queried", () => {
    const text = "The budget is $1,000.";
    expect(looksFabricated(text, new Set())).toBe(false);
  });

  it("returns false for plain text without figures or tables", () => {
    const text = "Here is some information about employees";
    expect(looksFabricated(text, new Set())).toBe(false);
  });

  it("detects decimal dollar amounts as repeated figures", () => {
    const text = "Cost is $1,234.56 and profit is $987.65.";
    expect(looksFabricated(text, new Set())).toBe(true);
  });
});
