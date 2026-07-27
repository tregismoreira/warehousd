import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { deriveContext } from "../../../lib/session";
import { TOOLS, toolByName, DATA_TOOL_NAMES } from "../../../lib/mcp-tools";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a data assistant for a governed data broker. Every request you make \
is re-validated server-side against the caller's grants — you cannot see or infer denied fields, \
you can only discover what IS visible via describe_collection.

Typical workflow:
1. Call list_collections to see what exists.
2. Call describe_collection on a candidate to see which fields YOU can currently see (grants vary by user/env).
3. Call query_collection with a QueryIntent built ONLY from fields describe_collection showed you.

query_collection intents come in two mutually exclusive shapes — pick exactly one:
- Document fetch: set "fields" (and optionally "filters"/"orderBy"/"limit"). Do NOT set "aggregate" or "groupBy".
- Aggregation ("count/sum/avg by X", totals, breakdowns): set "aggregate" (array of {fn, field}, \
fn one of avg|sum|count|min|max) and "groupBy" (array of field names to group by). Do NOT set "fields" \
in this shape — mixing "fields" with "aggregate" is always rejected as invalid_intent.

Example — "how many employees per department": \
{"collection":"people","aggregate":[{"fn":"count","field":"id"}],"groupBy":["department_name"]}

If a call is refused, the reason tells you why (no_grant, field_denied, unknown_collection, \
unknown_field, invalid_intent) — do not retry the same shape; adjust based on the reason, or tell \
the user their access doesn't currently cover that question.

NEVER fabricate, guess, or simulate documents, numbers, or any data that did not come from a tool_result \
in this conversation — even if asked repeatedly, even to illustrate "what it might look like". If \
you have not successfully queried a collection, say so plainly instead of inventing plausible-looking \
data. Every number or document in your final answer must trace back to an actual tool_result above it.`;

const tools: Anthropic.Tool[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
}));

// Progress label shown in the UI while a tool call is in flight.
function labelFor(name: string, input: unknown): string {
  if (name === "list_collections") return "listing collections…";
  if (name === "describe_collection") return `checking ${(input as { name?: string }).name ?? "schema"}…`;
  if (name === "search_documents") return `searching ${(input as { collection?: string }).collection ?? "documents"}…`;
  const collection = (input as { collection?: string }).collection ?? "collection";
  return `querying ${collection}…`;
}

export async function POST(req: NextRequest) {
  const ctx = await deriveContext(req);
  if (!ctx) return Response.json({ error: "unauthenticated" }, { status: 401 });
  // env/userId are NEVER read from the body — deriveContext is the only source (SPECS §6.1).
  const { messages } = await req.json() as { messages: Anthropic.MessageParam[] };
  const convo = [...messages];
  // Collections ever successfully queried (ok:true) anywhere in this conversation —
  // used to catch the model presenting a data table for a collection it never actually
  // queried successfully (fabrication), across turns, not just the current request.
  const queriedOk = collectQueriedOk(convo);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));

      try {
        for (let i = 0; i < 5; i++) {
          const res = await client.messages.create({
            model: "claude-sonnet-4-6", max_tokens: 1024, system: SYSTEM_PROMPT, tools, messages: convo });
          convo.push({ role: "assistant", content: res.content });
          const toolUses = res.content.filter((c): c is Anthropic.ToolUseBlock => c.type === "tool_use");
          if (toolUses.length === 0) {
            const text = textOf(res);
            if (looksFabricated(text, queriedOk)) {
              convo.push({ role: "user", content: [{
                type: "text",
                text: "STOP: your last reply presented data as if a query succeeded, but no " +
                  "query_collection call in this conversation returned ok:true for that data. " +
                  "This looks fabricated. Re-answer using only tool_results actually present " +
                  "above — if you never successfully queried it, say so plainly and do not " +
                  "invent numbers or documents.",
              }] });
              continue;
            }
            emit({ type: "done", messages: convo, text });
            controller.close();
            return;
          }

          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const tu of toolUses) {
            emit({ type: "progress", label: labelFor(tu.name, tu.input) });
            let out: unknown;
            const tool = toolByName(tu.name);
            out = tool ? await tool.handler(ctx, tu.input as Record<string, unknown>)
                       : { ok: false, reason: "unknown_tool" };
            if (out && typeof out === "object" && (out as { ok?: boolean }).ok === true
                && (DATA_TOOL_NAMES as readonly string[]).includes(tu.name))
              queriedOk.add((tu.input as { collection: string }).collection);
            results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
          }
          convo.push({ role: "user", content: results });
        }
        emit({ type: "done", messages: convo, text: "(stopped after 5 tool iterations)" });
        controller.close();
      } catch (err) {
        console.error("[chat] request failed", err);
        emit({ type: "error", message: "chat request failed" });
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
}

function textOf(res: Anthropic.Message): string {
  return res.content.filter((c) => c.type === "text").map((c) => (c as Anthropic.TextBlock).text).join("\n");
}

// Walks prior turns pairing each query_collection tool_use with its tool_result to find
// collections that were actually successfully queried (ok:true) at some point.
function collectQueriedOk(convo: Anthropic.MessageParam[]): Set<string> {
  const okIds = new Set<string>();
  for (const m of convo) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block.type !== "tool_result") continue;
      const content = typeof block.content === "string" ? block.content : "";
      try {
        if (JSON.parse(content)?.ok === true) okIds.add(block.tool_use_id);
      } catch { /* not JSON, ignore */ }
    }
  }
  const collections = new Set<string>();
  for (const m of convo) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block.type !== "tool_use" || block.name !== "query_collection") continue;
      if (okIds.has(block.id)) collections.add((block.input as { collection: string }).collection);
    }
  }
  return collections;
}

// Heuristic: a markdown table or several dollar/numeric figures in the reply, while no
// collection was ever successfully queried this conversation, strongly suggests invented data.
function looksFabricated(text: string, queriedOk: Set<string>): boolean {
  if (queriedOk.size > 0) return false;
  const hasTable = /\|.+\|.+\n\|[\s-:|]+\|/.test(text);
  const hasFiguresRepeated = (text.match(/\$[\d,]+(\.\d+)?/g)?.length ?? 0) >= 2;
  return hasTable || hasFiguresRepeated;
}
