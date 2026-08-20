import { z } from "zod";
import type { AclRefusalReason, MutationRefusalReason, RefusalReason } from "@warehousd/broker";
import { GRANT_REQUEST_ERRORS, QueryIntentSchema, Ident } from "@warehousd/broker";
import {
  TokenResponseSchema,
  CollectionListingSchema,
  VisibleSchemaSchema,
  BrokerResultOkSchema,
  MutationAppliedSchema,
  MutationPendingSchema,
  GetDocumentResultOkSchema,
  RevisionsResponseSchema,
  AclResultOkSchema,
  ProposalsResponseSchema,
  DecisionResultOkSchema,
  BatchDecisionsBodySchema,
  BatchDecisionOkSchema,
  BatchQueryBodySchema,
  BatchQueryOkSchema,
  ChangesResponseSchema,
  GrantsResponseSchema,
  GrantRequestCreatedSchema,
  GrantRequestBodySchema,
  SetAclBodySchema,
} from "./responses";

export type AnyReason = RefusalReason | MutationRefusalReason | AclRefusalReason;

export type Param = {
  name: string;
  in: "path" | "query";
  required?: boolean;
  schema: z.ZodType;
  description: string;
  style?: "form";
  explode?: boolean;
};

export type Success = {
  status: number;
  schema?: z.ZodType;
  description: string;
  headers?: string[];
};

export type Operation = {
  path: string; // "/v1/collections/{c}/documents/{id}"
  method: "get" | "post" | "put" | "delete";
  operationId: string;
  summary: string;
  tags: string[];
  params?: Param[];
  requestBody?: { schema: z.ZodType; description: string };
  // Each success the route can return, with the header it sets (if any).
  success: Success[];
  // Refusal reasons this operation can produce. Mapped to statuses through restStatus() —
  // never transcribed. Over-listing a reason is harmless; it documents one more status.
  reasons: AnyReason[];
  // True where restStatus's ifMatchProvided branch applies, i.e. the operation reads If-Match.
  conditional?: boolean;
  // OAuth-scheme operations (POST /v1/token) opt out of the broker refusal table entirely.
  oauthErrors?: boolean;
  // requestGrant's failures are GrantRequestError (grants/manage.ts) — a distinct type from the
  // broker's refusal reasons that never reaches restStatus(). The route maps it directly:
  // unknown_collection -> 404, everything else -> 400. This flag routes the generator around the
  // normal reasons/restStatus path for this one operation.
  grantRequestErrors?: boolean;
};

// The reason set common to every data operation. Declared once and spread so a per-operation list
// only has to name what it adds — "declared once as a const and spread" per the plan.
const RESTRICTED: AnyReason[] = [
  "no_grant",
  "expired_grant",
  "unknown_collection",
  "invalid_intent",
  "internal_error",
];

const MUTATION_EXTRA: AnyReason[] = [
  "verb_denied",
  "field_not_writable",
  "invalid_value",
  "not_writable",
  "verb_not_supported",
  "conflict",
];

const ACL_EXTRA: AnyReason[] = ["acl_denied", "not_writable"];

const cParam: Param = {
  name: "c",
  in: "path",
  required: true,
  // Sourced from intents/schema.ts's Ident, not retyped.
  schema: Ident,
  description: "Collection name.",
};

const idParam: Param = {
  name: "id",
  in: "path",
  required: true,
  schema: z.string(),
  description:
    "The primary key on a dataset collection, or the url-encoded path on a file collection.",
};

export const OPERATIONS: Operation[] = [
  {
    path: "/v1/token",
    method: "post",
    operationId: "mintToken",
    summary: "Mint an access token",
    tags: ["auth"],
    requestBody: {
      schema: z.object({
        grant_type: z.enum([
          "client_credentials",
          "urn:ietf:params:oauth:grant-type:token-exchange",
        ]),
        scope: z.string().optional(),
        client_id: z.string().optional(),
        client_secret: z.string().optional(),
        subject_token: z.string().optional(),
        subject_token_type: z.literal("urn:ietf:params:oauth:token-type:jwt").optional(),
      }),
      description:
        "application/x-www-form-urlencoded. Client authenticates with HTTP Basic " +
        "(Authorization: Basic base64(client_id:client_secret)) OR the client_id/client_secret " +
        "form fields above, never both.",
    },
    success: [{ status: 200, schema: TokenResponseSchema, description: "Token issued." }],
    reasons: [],
    oauthErrors: true,
  },
  {
    path: "/v1/collections",
    method: "get",
    operationId: "listCollections",
    summary: "List collections visible to the caller",
    tags: ["collections"],
    success: [
      {
        status: 200,
        schema: z.array(CollectionListingSchema),
        description: "Names and descriptions of every collection within the caller's ceiling.",
      },
    ],
    reasons: [...RESTRICTED],
  },
  {
    path: "/v1/collections/{c}",
    method: "get",
    operationId: "describeCollection",
    summary: "Describe one collection's granted fields",
    tags: ["collections"],
    params: [cParam],
    success: [
      { status: 200, schema: VisibleSchemaSchema, description: "The collection's visible schema." },
    ],
    reasons: [...RESTRICTED, "field_denied"],
  },
  {
    path: "/v1/collections/{c}/query",
    method: "post",
    operationId: "queryCollection",
    summary: "Structured query: filters, ordering, aggregation, grouping",
    tags: ["data"],
    params: [cParam],
    requestBody: {
      schema: QueryIntentSchema.omit({ collection: true }),
      description:
        "The collection comes from the path, never the body. `after` takes a previous response's " +
        "`nextCursor` for a stable keyset walk and is mutually exclusive with `offset` and `aggregate`.",
    },
    success: [{ status: 200, schema: BrokerResultOkSchema, description: "Matching documents." }],
    reasons: [...RESTRICTED, "field_denied", "unknown_field"],
  },
  {
    path: "/v1/batch",
    method: "post",
    operationId: "batchQuery",
    summary: "Run up to MAX_BATCH_QUERIES labelled queries in one request",
    tags: ["data"],
    requestBody: {
      schema: BatchQueryBodySchema,
      description:
        "Each entry is a QueryIntent plus a caller-chosen `label` used to key its slot in the " +
        "response. Sub-queries run sequentially and are independently grant-checked; a refusing " +
        "sub-query returns its own reason in its slot and does not change the HTTP status — the " +
        "envelope succeeds as long as the request itself was well-formed.",
    },
    success: [
      {
        status: 200,
        schema: BatchQueryOkSchema,
        description: "One result (or refusal) per label, in the same shape POST /query returns.",
      },
    ],
    reasons: [...RESTRICTED],
  },
  {
    path: "/v1/collections/{c}/search",
    method: "get",
    operationId: "searchCollection",
    summary: "Full-text search over a collection",
    tags: ["data"],
    params: [
      cParam,
      {
        name: "q",
        in: "query",
        required: true,
        schema: z.string(),
        description: "Search text.",
      },
      {
        name: "fields",
        in: "query",
        schema: z.array(z.string()),
        description: "Repeatable. Fields to return; defaults to every granted field.",
        style: "form",
        explode: true,
      },
      {
        name: "limit",
        in: "query",
        schema: z.number().int(),
        description:
          "Capped, not rejected: default 100, max 500. An oversized limit succeeds and is clamped.",
      },
      {
        name: "offset",
        in: "query",
        schema: z.number().int(),
        description: "Pagination offset.",
      },
    ],
    success: [{ status: 200, schema: BrokerResultOkSchema, description: "Matching documents." }],
    reasons: [...RESTRICTED, "field_denied", "unknown_field"],
  },
  {
    path: "/v1/collections/{c}/documents",
    method: "post",
    operationId: "createDocument",
    summary: "Create a document",
    tags: ["data"],
    params: [cParam],
    requestBody: {
      schema: z.record(Ident, z.unknown()),
      description:
        "A free-form map of field name to value — not a { values: … } wrapper, not a MutationIntent. " +
        "Field names must match ^[a-z_][a-z0-9_]*$.",
    },
    success: [
      {
        status: 201,
        schema: MutationAppliedSchema,
        description: "Applied immediately.",
        headers: ["Location"],
      },
      { status: 202, schema: MutationPendingSchema, description: "Stored as a pending proposal." },
    ],
    reasons: [...RESTRICTED, ...MUTATION_EXTRA],
  },
  {
    path: "/v1/collections/{c}/documents/{id}",
    method: "get",
    operationId: "getDocument",
    summary: "Fetch one document",
    tags: ["data"],
    params: [cParam, idParam],
    success: [
      {
        status: 200,
        schema: GetDocumentResultOkSchema,
        description: "The document, at its full granted field set.",
        headers: ["ETag"],
      },
    ],
    reasons: [...RESTRICTED, "field_denied", "not_found"],
  },
  {
    path: "/v1/collections/{c}/documents/{id}",
    method: "put",
    operationId: "updateDocument",
    summary: "Update a document",
    tags: ["data"],
    params: [cParam, idParam],
    requestBody: {
      schema: z.record(Ident, z.unknown()),
      description:
        "A free-form map of field name to value — not a { values: … } wrapper, not a MutationIntent. " +
        'Field names must match ^[a-z_][a-z0-9_]*$. If-Match: "{rev}" selects optimistic concurrency.',
    },
    success: [
      {
        status: 200,
        schema: MutationAppliedSchema,
        description: "Applied immediately.",
        headers: ["ETag"],
      },
      { status: 202, schema: MutationPendingSchema, description: "Stored as a pending proposal." },
    ],
    reasons: [...RESTRICTED, ...MUTATION_EXTRA, "not_found"],
    conditional: true,
  },
  {
    path: "/v1/collections/{c}/documents/{id}",
    method: "delete",
    operationId: "deleteDocument",
    summary: "Delete a document",
    tags: ["data"],
    params: [cParam, idParam],
    success: [
      { status: 204, description: "Deleted immediately. No response body (RFC 7231 §6.3.5)." },
      { status: 202, schema: MutationPendingSchema, description: "Stored as a pending proposal." },
    ],
    reasons: [...RESTRICTED, ...MUTATION_EXTRA, "not_found"],
  },
  {
    path: "/v1/collections/{c}/documents/{id}/revisions",
    method: "get",
    operationId: "listRevisions",
    summary: "List a document's revision history",
    tags: ["history"],
    params: [cParam, idParam],
    success: [
      { status: 200, schema: RevisionsResponseSchema, description: "The document's revisions." },
    ],
    reasons: [...RESTRICTED, "not_found"],
  },
  {
    path: "/v1/collections/{c}/documents/{id}/acl",
    method: "get",
    operationId: "getDocumentAcl",
    summary: "Read a document's ACL",
    tags: ["acl"],
    params: [cParam, idParam],
    success: [{ status: 200, schema: AclResultOkSchema, description: "The document's ACL." }],
    reasons: [...RESTRICTED, ...ACL_EXTRA, "not_found"],
  },
  {
    path: "/v1/collections/{c}/documents/{id}/acl",
    method: "put",
    operationId: "setDocumentAcl",
    summary: "Replace a document's ACL",
    tags: ["acl"],
    params: [cParam, idParam],
    requestBody: {
      schema: SetAclBodySchema,
      description: "An empty principals list removes the ACL.",
    },
    success: [{ status: 200, schema: AclResultOkSchema, description: "The document's ACL." }],
    reasons: [...RESTRICTED, ...ACL_EXTRA, "not_found", "invalid_value"],
  },
  {
    path: "/v1/collections/{c}/documents/{id}/acl",
    method: "delete",
    operationId: "clearDocumentAcl",
    summary: "Remove a document's ACL",
    tags: ["acl"],
    params: [cParam, idParam],
    success: [
      {
        status: 200,
        schema: AclResultOkSchema,
        description: "The document is public within the grant again.",
      },
    ],
    reasons: [...RESTRICTED, ...ACL_EXTRA, "not_found"],
  },
  {
    path: "/v1/proposals",
    method: "get",
    operationId: "listProposals",
    summary: "List proposals",
    tags: ["proposals"],
    params: [
      {
        name: "status",
        in: "query",
        schema: z.enum(["pending", "approved", "rejected"]),
        description: "Filter by decision status.",
      },
      {
        name: "collection",
        in: "query",
        schema: z.string(),
        description: "Filter by collection.",
      },
    ],
    success: [{ status: 200, schema: ProposalsResponseSchema, description: "Matching proposals." }],
    reasons: [...RESTRICTED],
  },
  {
    path: "/v1/proposals/{id}/approve",
    method: "post",
    operationId: "approveProposal",
    summary: "Approve a proposal",
    tags: ["proposals"],
    params: [
      {
        name: "id",
        in: "path",
        required: true,
        schema: z.string(),
        description: "Proposal id.",
      },
    ],
    success: [
      { status: 200, schema: DecisionResultOkSchema, description: "The document as written." },
    ],
    reasons: [...RESTRICTED, "self_approval_denied", "conflict", "not_found", "verb_denied"],
  },
  {
    path: "/v1/proposals/{id}/reject",
    method: "post",
    operationId: "rejectProposal",
    summary: "Reject a proposal",
    tags: ["proposals"],
    params: [
      {
        name: "id",
        in: "path",
        required: true,
        schema: z.string(),
        description: "Proposal id.",
      },
    ],
    success: [
      {
        status: 200,
        schema: DecisionResultOkSchema,
        description: "The rejected proposal's outcome.",
      },
    ],
    reasons: [...RESTRICTED, "not_found", "verb_denied"],
  },
  {
    path: "/v1/proposals/decide",
    method: "post",
    operationId: "decideProposals",
    summary: "Decide on a batch of proposals atomically",
    tags: ["proposals"],
    requestBody: {
      schema: BatchDecisionsBodySchema,
      description:
        "Up to MAX_BATCH_DECISIONS decisions, each an independent approve or reject. Either " +
        "every one of them commits or none does — the first refusal rolls the whole batch back.",
    },
    success: [
      {
        status: 200,
        schema: BatchDecisionOkSchema,
        description: "Every decision in the batch committed.",
      },
    ],
    reasons: [
      ...RESTRICTED,
      "self_approval_denied",
      "conflict",
      "not_found",
      "verb_denied",
      "field_denied",
      "not_writable",
      "batch_aborted",
    ],
  },
  {
    path: "/v1/changes",
    method: "get",
    operationId: "listChanges",
    summary: "Change feed",
    tags: ["history"],
    params: [
      {
        name: "since",
        in: "query",
        schema: z.number().int(),
        description: "Sequence number to start after.",
      },
      {
        name: "limit",
        in: "query",
        schema: z.number().int(),
        description: "Capped, not rejected: default 100, max 500.",
      },
    ],
    success: [
      {
        status: 200,
        schema: ChangesResponseSchema,
        description: "Document mutations for this org/env.",
      },
    ],
    reasons: [...RESTRICTED],
  },
  {
    path: "/v1/grants",
    method: "get",
    operationId: "listGrants",
    summary: "List the caller's grants",
    tags: ["grants"],
    success: [
      {
        status: 200,
        schema: GrantsResponseSchema,
        description:
          "select * from app.grants for this caller, plus computed effectiveStatus/collectionType/" +
          "taxonomyFields. additionalProperties is open on purpose — see docs/rest-api.md known warts.",
      },
    ],
    reasons: [...RESTRICTED],
  },
  {
    path: "/v1/grants",
    method: "post",
    operationId: "requestGrant",
    summary: "Request access to a collection",
    tags: ["grants"],
    requestBody: {
      schema: GrantRequestBodySchema,
      description: "Validated by validateGrantRequest, not by the broker's intent schemas.",
    },
    success: [
      { status: 201, schema: GrantRequestCreatedSchema, description: "Grant request recorded." },
    ],
    reasons: [],
    grantRequestErrors: true,
  },
];

// One reason list per data operation is redundant with restStatus() reachability, so the values
// above name only what the plan and a read of each verb agreed the operation can return; over-
// listing is deliberate per the plan and harmless — it documents one more status.
export { RESTRICTED, GRANT_REQUEST_ERRORS };
