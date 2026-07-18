import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { getBroker } from "../../lib/broker";
import { contextFor, type PersonaId } from "../../lib/persona";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const tools: Anthropic.Tool[] = [
  { name: "list_collections", description:
      "List collections (name + description only). Governance is deny-by-default and purpose-bound.",
    input_schema: { type: "object", properties: {} } },
  { name: "describe_collection", description:
      "Schema of fields VISIBLE UNDER THE CALLER'S GRANTS in the current env. No grant → refusal.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "query_collection", description:
      "Run a structured QueryIntent. The broker re-validates every field against the caller's grant; " +
      "denied fields are never returned. You are an untrusted proposer.",
    input_schema: { type: "object", properties: {
      collection: { type: "string" }, fields: { type: "array", items: { type: "string" } },
      filters: { type: "array" }, orderBy: { type: "object" }, limit: { type: "number" },
      aggregate: { type: "array" }, groupBy: { type: "array", items: { type: "string" } },
    }, required: ["collection"] } },
];

export async function POST(req: NextRequest) {
  const { persona, env, messages } = await req.json() as
    { persona: PersonaId; env: "dev" | "live"; messages: Anthropic.MessageParam[] };
  const { broker } = getBroker();
  const ctx = contextFor(persona, env);
  const convo = [...messages];

  for (let i = 0; i < 5; i++) {
    const res = await client.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 1024, tools, messages: convo });
    convo.push({ role: "assistant", content: res.content });
    const toolUses = res.content.filter((c): c is Anthropic.ToolUseBlock => c.type === "tool_use");
    if (toolUses.length === 0)
      return Response.json({ messages: convo, text: textOf(res) });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      let out: unknown;
      if (tu.name === "list_collections") out = await broker.listCollections(ctx);
      else if (tu.name === "describe_collection")
        out = await broker.describeCollection(ctx, (tu.input as { name: string }).name);
      else out = await broker.query(ctx, tu.input as never);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
    }
    convo.push({ role: "user", content: results });
  }
  return Response.json({ messages: convo, text: "(stopped after 5 tool iterations)" });
}

function textOf(res: Anthropic.Message): string {
  return res.content.filter((c) => c.type === "text").map((c) => (c as Anthropic.TextBlock).text).join("\n");
}
