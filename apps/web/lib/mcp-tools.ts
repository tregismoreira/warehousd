import { z } from "zod";
import type { BrokerContext } from "@warehousd/broker";
import {
  requestGrant,
  validateGrantRequest,
  QueryIntentSchema,
  DocSearchIntentSchema,
  GetDocumentIntentSchema,
  ListRevisionsIntentSchema,
  GetRevisionIntentSchema,
  DiffRevisionsIntentSchema,
  MutationIntentSchema,
} from "@warehousd/broker";
import { getBroker, getAppPool, getConfig } from "../app/lib/broker";

export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

// The advertised schema, derived from the schema the handler enforces, with this tool's
// model-facing prose merged back in.
//
// Why derive at all: these two used to be written twice and had already drifted — the advertised
// query and search schemas were missing `offset`, so a model reading them could not paginate
// against a broker that would have accepted it. The prose is the part worth writing by hand;
// the shape is not.
export function advertise(
  schema: z.ZodType,
  descriptions: Record<string, string>,
  opts: { omit?: string[] } = {},
): JsonSchema {
  const raw = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  const omit = new Set(opts.omit ?? []);

  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw.properties)) {
    if (omit.has(key)) continue;
    properties[key] = value;
  }

  for (const [key, description] of Object.entries(descriptions)) {
    if (!(key in raw.properties)) {
      throw new Error(
        `advertise(): description given for a property that does not exist: "${key}"`,
      );
    }
    properties[key] = { ...(properties[key] as Record<string, unknown>), description };
  }

  const required = raw.required?.filter((key) => !omit.has(key));
  return required?.length
    ? { type: "object", properties, required }
    : { type: "object", properties };
}

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (ctx: BrokerContext, input: Record<string, unknown>) => Promise<unknown>;
};

const REQUEST_ACCESS_HINT =
  "Refused. If this was no_grant or field_denied, call request_access with the collection, a " +
  "purpose, and (optionally) the fields you need — this creates a pending request a manager " +
  "can approve.";

// Every tool's refusal shape (ok:false) gets this hint added in one place, so every tool surfaces
// it without each having to remember to.
function withHint(out: unknown): unknown {
  if (out && typeof out === "object" && (out as { ok?: boolean }).ok === false) {
    return { ...out, hint: REQUEST_ACCESS_HINT };
  }
  return out;
}

// The three write tools differ only in which op they name and which fields that op carries, so
// they share one parse. MutationIntentSchema is a discriminated union on `op`, which is what
// makes "update without an id" or "delete carrying values" a refusal rather than something the
// broker has to notice later.
async function mutateChecked(ctx: BrokerContext, input: Record<string, unknown>): Promise<unknown> {
  const parsed = MutationIntentSchema.safeParse(input);
  if (!parsed.success) return withHint({ ok: false, reason: "invalid_intent" });
  return withHint(await getBroker().broker.mutate(ctx, parsed.data));
}

export const TOOLS: ToolDef[] = [
  {
    name: "list_collections",
    description:
      'List collections, each with YOUR OWN access to it: `access` is "granted" when you hold ' +
      'a read grant and "none" when you do not, and `grantedFields` counts the fields that ' +
      'grant carries. Start here — a collection marked "none" will refuse every call, so there ' +
      "is no reason to describe or query it; ask for it with request_access instead. Governance " +
      "is deny-by-default and purpose-bound: this list confers no access to any data or schema.",
    inputSchema: { type: "object", properties: {} },
    handler: async (ctx) => withHint(await getBroker().broker.listCollections(ctx)),
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
      '"fields", never combine with "aggregate"/"groupBy"; (2) aggregation (counts, sums, ' +
      'averages, breakdowns "by X") — use "aggregate" + "groupBy", never set "fields". ' +
      'Example aggregation: aggregate=[{"fn":"count","field":"id"}], ' +
      'groupBy=["department_name"]. Refusals are deny-by-default and purpose-bound; a refusal ' +
      "includes a request_access hint.",
    inputSchema: advertise(
      QueryIntentSchema,
      {
        collection: "Collection name, from list_collections.",
        fields: "Document-fetch shape only. Field names to return; omit for aggregation.",
        limit: "Default 100, max 500.",
        offset: "Pagination offset, paired with limit.",
        aggregate: "Aggregation shape only. e.g. count/sum/avg per group.",
        groupBy: "Aggregation shape only. Field names to group by.",
      },
      // `after` (keyset pagination) is deliberately not advertised here — decisions taken, "no new
      // MCP tools": widening what an untrusted proposer can do through the model-facing surface is
      // a separate call from the REST surface's own. The handler still accepts it if a caller
      // passes it through the raw JSON-RPC arguments; it is simply not documented to a model.
      { omit: ["after"] },
    ),
    handler: async (ctx, input) => {
      // inputSchema above is advertised to the client, not enforced by it: the SDK's low-level
      // setRequestHandler(CallToolRequestSchema) validates the JSON-RPC envelope and passes
      // `arguments` through untouched, so the `enum`s in it are documentation. The model is the
      // untrusted party here — parse before the broker sees it.
      const parsed = QueryIntentSchema.safeParse(input);
      if (!parsed.success) return withHint({ ok: false, reason: "invalid_intent" });
      return withHint(await getBroker().broker.query(ctx, parsed.data));
    },
  },
  {
    name: "search_documents",
    description:
      "Search documents. OMIT `collection` to search every collection you hold a read grant on " +
      "at once — results are merged by reciprocal-rank fusion and each document carries a " +
      "`_collection` field saying where it came from, which is what get_document needs. Name a " +
      "collection to search just that one. Access is deny-by-default and purpose-bound: results contain " +
      "only fields covered by your approved grant, restricted to documents your grant allows. " +
      'Three modes: "text" (default) matches words; "semantic" matches meaning and will find a ' +
      'document that shares no words with your query; "hybrid" fuses both rankings and is ' +
      "usually the best default when you are exploring. Semantic and hybrid need the deployment " +
      "to have embeddings configured, and work on file collections only — asking for one where " +
      "it is unavailable refuses rather than quietly running a text search. Refusals include a " +
      "request_access hint.",
    inputSchema: advertise(DocSearchIntentSchema, {
      collection:
        "Optional. Omit to search every collection you hold a read grant on and merge the results.",
      mode: "Ranking strategy. Defaults to text.",
      offset: "Pagination offset, paired with limit.",
    }),
    handler: async (ctx, input) => {
      const parsed = DocSearchIntentSchema.safeParse(input);
      if (!parsed.success) return withHint({ ok: false, reason: "invalid_intent" });
      return withHint(await getBroker().broker.searchDocuments(ctx, parsed.data));
    },
  },
  {
    name: "get_document",
    description:
      "Fetch a single document by id or path (file collections). Governance is deny-by-default " +
      "and field-scoped: returned fields are restricted to your active grant. Refusal includes " +
      "a request_access hint.",
    // Hand-written, not derived, and deliberately so: GetDocumentIntentSchema is a union of two
    // object shapes (id XOR path), which z.toJSONSchema renders as `anyOf` — advertising that to
    // a model degrades tool-call quality for a constraint the handler enforces anyway via
    // safeParse below. mcp-schema-parity.test.ts pins this flat shape against the union of both
    // branches' properties so it cannot rot silently.
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
        id: {
          type: "string",
          description:
            "Document id (pk for datasets, file_id for files). Mutually exclusive with path.",
        },
        path: {
          type: "string",
          description: "Source file path (file collections only). Mutually exclusive with id.",
        },
      },
      required: ["collection"],
    },
    handler: async (ctx, input) => {
      // id and path are mutually exclusive, and the schema is a union of the two shapes, so
      // "both" and "neither" are both rejected here rather than resolved by precedence.
      const parsed = GetDocumentIntentSchema.safeParse(input);
      if (!parsed.success) return withHint({ ok: false, reason: "invalid_intent" });
      return withHint(await getBroker().broker.getDocument(ctx, parsed.data));
    },
  },
  {
    name: "list_revisions",
    description:
      "Every revision of one document, newest last. Metadata only — who changed it, when, and " +
      "which of the fields you can read moved. Use get_revision to read the values.",
    inputSchema: advertise(ListRevisionsIntentSchema, {
      collection: "Collection name.",
      id: "Document id.",
    }),
    handler: async (ctx, input) => {
      const parsed = ListRevisionsIntentSchema.safeParse(input);
      if (!parsed.success) return withHint({ ok: false, reason: "invalid_intent" });
      return withHint(await getBroker().broker.listRevisions(ctx, parsed.data));
    },
  },
  {
    name: "get_revision",
    description:
      "One past revision of a document. Fields you cannot read are absent and masked fields " +
      "stay masked, exactly as in get_document — the grant and the postures applied are the " +
      "current ones, not the ones in force when the revision was written.",
    inputSchema: advertise(GetRevisionIntentSchema, {
      collection: "Collection name.",
      id: "Document id.",
      rev: "Revision id, as returned by list_revisions.",
    }),
    handler: async (ctx, input) => {
      const parsed = GetRevisionIntentSchema.safeParse(input);
      if (!parsed.success) return withHint({ ok: false, reason: "invalid_intent" });
      return withHint(await getBroker().broker.getRevision(ctx, parsed.data));
    },
  },
  {
    name: "diff_revisions",
    description:
      "The fields that moved between two revisions of one document. A masked field is masked on " +
      "both sides, so a diff of one can read as unchanged even when the value moved.",
    inputSchema: advertise(DiffRevisionsIntentSchema, {
      collection: "Collection name.",
      id: "Document id.",
      from: "The earlier revision id.",
      to: "The later revision id.",
    }),
    handler: async (ctx, input) => {
      const parsed = DiffRevisionsIntentSchema.safeParse(input);
      if (!parsed.success) return withHint({ ok: false, reason: "invalid_intent" });
      return withHint(await getBroker().broker.diffRevisions(ctx, parsed.data));
    },
  },
  // Approve and reject are deliberately NOT MCP tools — the untrusted model may propose, but not
  // decide. Adding them here would not by itself let the model approve its own work (the broker
  // refuses self_approval_denied against the proposal's _rev_by), but it would let it approve
  // another proposer's, which is not a decision an untrusted party gets to make.
  {
    name: "create_document",
    description:
      "Create a document in a writable collection. Governance is deny-by-default: the " +
      "operation requires an active create grant. A write may return status:pending (invisible " +
      "to everyone until a human approves it); the model cannot approve its own proposal. " +
      "Refusals include a request_access hint.",
    inputSchema: advertise(
      MutationIntentSchema.options[0],
      { values: "Field values for the new document." },
      { omit: ["op"] },
    ),
    handler: async (ctx, input) => mutateChecked(ctx, { ...input, op: "create" }),
  },
  {
    name: "update_document",
    description:
      "Update an existing document. Governance is deny-by-default: the operation requires an " +
      "active update grant. A write may return status:pending (invisible to everyone until a " +
      "human approves it); the model cannot approve its own proposal. Refusals include a " +
      "request_access hint.",
    inputSchema: advertise(
      MutationIntentSchema.options[1],
      {
        id: "Document id (pk).",
        values: "Fields to update.",
        expect: "Optional revision to enforce optimistic concurrency.",
      },
      { omit: ["op"] },
    ),
    handler: async (ctx, input) => mutateChecked(ctx, { ...input, op: "update" }),
  },
  {
    name: "delete_document",
    description:
      "Delete a document. Governance is deny-by-default: the operation requires an active " +
      "delete grant. A write may return status:pending (invisible to everyone until a human " +
      "approves it); the model cannot approve its own proposal. Refusals include a " +
      "request_access hint.",
    inputSchema: advertise(
      MutationIntentSchema.options[2],
      {
        id: "Document id (pk).",
        expect: "Optional revision to enforce optimistic concurrency.",
      },
      { omit: ["op"] },
    ),
    handler: async (ctx, input) => mutateChecked(ctx, { ...input, op: "delete" }),
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
        purpose: {
          type: "string",
          description: "Why you need this access — shown to the approver.",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Fields you need. Omit to let the approver decide scope from the purpose.",
        },
      },
      required: ["collection", "purpose"],
    },
    handler: async (ctx, input) => {
      const cfg = getConfig();
      const validation = validateGrantRequest(
        cfg,
        input.collection as string,
        input.purpose,
        input.fields,
      );
      if (!validation.ok) return withHint({ ok: false, reason: validation.error });

      const requestId = await requestGrant(getAppPool(), {
        userId: ctx.userId,
        collection: input.collection as string,
        env: ctx.env,
        workspaceId: ctx.workspaceId,
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
