import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { getBroker } from "../../lib/broker";
import { contextFor, type PersonaId } from "../../lib/persona";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a data assistant for a governed data broker. Every request you make \
is re-validated server-side against the caller's grants — you cannot see or infer denied fields, \
you can only discover what IS visible via describe_collection.

Typical workflow:
1. Call list_collections to see what exists.
2. Call describe_collection on a candidate to see which fields YOU can currently see (grants vary by user/env).
3. Call query_collection with a QueryIntent built ONLY from fields describe_collection showed you.

query_collection intents come in two mutually exclusive shapes — pick exactly one:
- Row fetch: set "fields" (and optionally "filters"/"orderBy"/"limit"). Do NOT set "aggregate" or "groupBy".
- Aggregation ("count/sum/avg by X", totals, breakdowns): set "aggregate" (array of {fn, field}, \
fn one of avg|sum|count|min|max) and "groupBy" (array of field names to group by). Do NOT set "fields" \
in this shape — mixing "fields" with "aggregate" is always rejected as invalid_intent.

Example — "how many employees per department": \
{"collection":"people","aggregate":[{"fn":"count","field":"id"}],"groupBy":["department_name"]}

If a call is refused, the reason tells you why (no_grant, field_denied, unknown_collection, \
unknown_field, invalid_intent) — do not retry the same shape; adjust based on the reason, or tell \
the user their access doesn't currently cover that question.`;

const tools: Anthropic.Tool[] = [
  { name: "list_collections", description:
      "List collections (name + description only). Governance is deny-by-default and purpose-bound.",
    input_schema: { type: "object", properties: {} } },
  { name: "describe_collection", description:
      "Schema of fields VISIBLE UNDER THE CALLER'S GRANTS in the current env. No grant → refusal. " +
      "Always call this before query_collection on a collection you haven't described yet in this " +
      "conversation — it tells you exactly which field names are usable.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "query_collection", description:
      "Run a structured QueryIntent. The broker re-validates every field against the caller's grant; " +
      "denied fields are never returned, and referencing one anywhere (fields, filters, orderBy, " +
      "aggregate, groupBy) refuses the whole call. You are an untrusted proposer — the broker is the " +
      "source of truth, not your assumptions. Two mutually exclusive shapes: (1) row fetch — use " +
      "\"fields\", never combine with \"aggregate\"/\"groupBy\"; (2) aggregation (counts, sums, " +
      "averages, breakdowns \"by X\") — use \"aggregate\" + \"groupBy\", never set \"fields\". " +
      "Example aggregation: aggregate=[{\"fn\":\"count\",\"field\":\"id\"}], groupBy=[\"department_name\"].",
    input_schema: { type: "object", properties: {
      collection: { type: "string", description: "Collection name, from list_collections." },
      fields: { type: "array", items: { type: "string" },
        description: "Row-fetch shape only. Field names to return; omit for aggregation." },
      filters: { type: "array", items: { type: "object", properties: {
        field: { type: "string" },
        op: { type: "string", enum: ["eq", "neq", "gt", "lt", "gte", "lte", "like", "in"] },
        value: {},
      }, required: ["field", "op", "value"] } },
      orderBy: { type: "object", properties: {
        field: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } } },
      limit: { type: "number", description: "Default 100, max 500." },
      aggregate: { type: "array", items: { type: "object", properties: {
        fn: { type: "string", enum: ["avg", "sum", "count", "min", "max"] },
        field: { type: "string" },
      }, required: ["fn", "field"] },
        description: "Aggregation shape only. e.g. count/sum/avg per group." },
      groupBy: { type: "array", items: { type: "string" },
        description: "Aggregation shape only. Field names to group by." },
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
      model: "claude-sonnet-4-6", max_tokens: 1024, system: SYSTEM_PROMPT, tools, messages: convo });
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
