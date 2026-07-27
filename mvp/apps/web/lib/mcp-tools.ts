import type { BrokerContext, QueryIntent, DocSearchIntent } from "@warehousd/broker";
import { requestGrant, validateGrantRequest } from "@warehousd/broker";
import { getBroker, getAppPool, getConfig } from "../app/lib/broker";

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
  {
    name: "query_collection",
    description:
      "Run a structured QueryIntent. The broker re-validates every field against the caller's " +
      "grant; denied fields are never returned, and referencing one anywhere (fields, filters, " +
      "orderBy, aggregate, groupBy) refuses the whole call — you are an untrusted proposer, the " +
      "broker is the source of truth. Two mutually exclusive shapes: (1) document fetch — use " +
      "\"fields\", never combine with \"aggregate\"/\"groupBy\"; (2) aggregation (counts, sums, " +
      "averages, breakdowns \"by X\") — use \"aggregate\" + \"groupBy\", never set \"fields\". " +
      "Example aggregation: aggregate=[{\"fn\":\"count\",\"field\":\"id\"}], " +
      "groupBy=[\"department_name\"]. Refusals are deny-by-default and purpose-bound; a refusal " +
      "includes a request_access hint.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name, from list_collections." },
        fields: {
          type: "array", items: { type: "string" },
          description: "Document-fetch shape only. Field names to return; omit for aggregation.",
        },
        filters: {
          type: "array", items: {
            type: "object",
            properties: {
              field: { type: "string" },
              op: { type: "string", enum: ["eq", "neq", "gt", "lt", "gte", "lte", "like", "in"] },
              value: {},
            },
            required: ["field", "op", "value"],
          },
        },
        orderBy: {
          type: "object",
          properties: { field: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } },
        },
        limit: { type: "number", description: "Default 100, max 500." },
        aggregate: {
          type: "array", items: {
            type: "object",
            properties: {
              fn: { type: "string", enum: ["avg", "sum", "count", "min", "max"] },
              field: { type: "string" },
            },
            required: ["fn", "field"],
          },
          description: "Aggregation shape only. e.g. count/sum/avg per group.",
        },
        groupBy: {
          type: "array", items: { type: "string" },
          description: "Aggregation shape only. Field names to group by.",
        },
      },
      required: ["collection"],
    },
    handler: async (ctx, input) =>
      withHint(await getBroker().broker.query(ctx, input as unknown as QueryIntent)),
  },
  {
    name: "search_documents",
    description:
      "Full-text search over a file collection. Access is deny-by-default and purpose-bound: " +
      "results contain only fields covered by your approved grant, restricted to documents your " +
      "grant allows. Refusals include a request_access hint.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        q: { type: "string" },
        fields: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
      },
      required: ["collection", "q"],
    },
    handler: async (ctx, input) =>
      withHint(await getBroker().broker.searchDocuments(ctx, input as unknown as DocSearchIntent)),
  },
  {
    name: "request_access",
    description:
      "Request access to a collection you currently can't see, or can't fully see. Creates a " +
      "pending request a manager or admin can approve; returns the request id. Use this whenever " +
      "another tool refuses with no_grant or field_denied.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string" },
        purpose: { type: "string", description: "Why you need this access — shown to the approver." },
        fields: {
          type: "array", items: { type: "string" },
          description: "Fields you need. Omit to let the approver decide scope from the purpose.",
        },
      },
      required: ["collection", "purpose"],
    },
    handler: async (ctx, input) => {
      const cfg = getConfig();
      const validation = validateGrantRequest(cfg, input.collection as string, input.purpose, input.fields);
      if (!validation.ok)
        return withHint({ ok: false, reason: validation.error });

      const requestId = await requestGrant(getAppPool(), {
        userId: ctx.userId,
        collection: input.collection as string,
        env: ctx.env,
        purposeLabel: input.purpose as string,
        allowedFields: validation.fields,
      });
      return { ok: true, requestId };
    },
  },
];

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}
