import type { BrokerContext, QueryIntent, DocSearchIntent } from "@warehousd/broker";
// requestGrant/getAppPool are unused until the request_access tool lands (Task 3) — kept
// imported now so that task is a pure addition to this file, not an import-list edit too.
import { requestGrant } from "@warehousd/broker";
import { getBroker, getAppPool } from "../app/lib/broker";

export type JsonSchema = { type: "object"; properties: Record<string, unknown>; required?: string[] };

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (ctx: BrokerContext, input: Record<string, unknown>) => Promise<unknown>;
};

// query_collection and search_documents are the two tools whose ok:true result means a
// collection was actually queried — the chat route's fabrication guard keys off this list
// instead of a hardcoded name check, so the guard can never drift from the tool set below.
export const DATA_TOOL_NAMES = ["query_collection", "search_documents"] as const;

const REQUEST_ACCESS_HINT =
  "Refused. If this was no_grant or field_denied, call request_access with the collection, a " +
  "purpose, and (optionally) the fields you need — this creates a pending request a manager " +
  "can approve.";

// Every tool's refusal shape (ok:false) gets this hint added in one place, so both the MCP
// endpoint and the chat console surface it without either having to remember to.
function withHint(out: unknown): unknown {
  if (out && typeof out === "object" && (out as { ok?: boolean }).ok === false) {
    return { ...out, hint: REQUEST_ACCESS_HINT };
  }
  return out;
}

export const TOOLS: ToolDef[] = [
  {
    name: "list_collections",
    description:
      "List collections (name + description only). Governance is deny-by-default and " +
      "purpose-bound: this list does not confer access to any collection's data or schema.",
    inputSchema: { type: "object", properties: {} },
    handler: async (ctx) => getBroker().broker.listCollections(ctx),
  },
  {
    name: "describe_collection",
    description:
      "Schema of fields VISIBLE UNDER THE CALLER'S GRANTS in the current env. No grant → " +
      "refusal (with a request_access hint). Always call this before query_collection or " +
      "search_documents on a collection you haven't described yet — it tells you exactly " +
      "which field names are usable.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    handler: async (ctx, input) =>
      withHint(await getBroker().broker.describeCollection(ctx, input.name as string)),
  },
];

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}
