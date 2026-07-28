import type Anthropic from "@anthropic-ai/sdk";

// Walks prior turns pairing each query_collection tool_use with its tool_result to find
// collections that were actually successfully queried (ok:true) at some point.
export function collectQueriedOk(convo: Anthropic.MessageParam[]): Set<string> {
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
export function looksFabricated(text: string, queriedOk: Set<string>): boolean {
  if (queriedOk.size > 0) return false;
  const hasTable = /\|.+\|.+\n\|[\s-:|]+\|/.test(text);
  const hasFiguresRepeated = (text.match(/\$[\d,]+(\.\d+)?/g)?.length ?? 0) >= 2;
  return hasTable || hasFiguresRepeated;
}
