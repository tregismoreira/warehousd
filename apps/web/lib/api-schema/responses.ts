import { z } from "zod";
import {
  REFUSAL_REASONS,
  MUTATION_REFUSAL_REASONS,
  ACL_REFUSAL_REASONS,
  GRANT_REQUEST_ERRORS,
  PROPOSAL_ACTIONS,
  QueryIntentSchema,
} from "@warehousd/broker";

// A document's fields are per-deployment config. A spec cannot enumerate them, and must not try:
// the field names of a deployment are exactly what a grant decides who may see.
export const DocumentSchema = z.record(z.string(), z.unknown());

// Null on a refusal means the audit insert failed; null on a success means audit.enabled is
// false. Never absent — see the note on AuditId in packages/broker/src/types.ts.
export const AuditIdSchema = z.string().nullable();

export const RefusalReasonSchema = z.enum(REFUSAL_REASONS);
export const MutationRefusalReasonSchema = z.enum(MUTATION_REFUSAL_REASONS);
export const AclRefusalReasonSchema = z.enum(ACL_REFUSAL_REASONS);

export const RefusalSchema = z.object({
  ok: z.literal(false),
  reason: RefusalReasonSchema,
  auditId: AuditIdSchema,
});
export const MutationRefusalSchema = z.object({
  ok: z.literal(false),
  reason: MutationRefusalReasonSchema,
  auditId: AuditIdSchema,
});

export const SearchedCollectionSchema = z.object({
  collection: z.string(),
  matched: z.number(),
  reason: RefusalReasonSchema.nullable(),
  auditId: AuditIdSchema,
});

export const BrokerResultOkSchema = z.object({
  ok: z.literal(true),
  documents: z.array(DocumentSchema),
  fieldsReturned: z.array(z.string()),
  auditId: AuditIdSchema,
  collections: z.array(SearchedCollectionSchema).optional(),
  // Present only when this page came back full — the caller's signal that the keyset walk has
  // more to fetch. See QueryIntentSchema's `after` in routes.ts and packages/broker/src/types.ts.
  nextCursor: z.string().optional(),
});
export const BrokerResultSchema = z.union([BrokerResultOkSchema, RefusalSchema]);

export const GetDocumentResultOkSchema = z.object({
  ok: z.literal(true),
  document: DocumentSchema,
  fieldsReturned: z.array(z.string()),
  rev: z.string().optional(),
  auditId: AuditIdSchema,
});
export const GetDocumentResultSchema = z.union([GetDocumentResultOkSchema, RefusalSchema]);

export const MutationAppliedSchema = z.object({
  ok: z.literal(true),
  status: z.literal("applied"),
  documentId: z.string(),
  rev: z.string(),
  auditId: AuditIdSchema,
});
export const MutationPendingSchema = z.object({
  ok: z.literal(true),
  status: z.literal("pending"),
  proposalId: z.string(),
  auditId: AuditIdSchema,
});
export const MutationResultSchema = z.union([
  MutationAppliedSchema,
  MutationPendingSchema,
  MutationRefusalSchema,
]);

export const VisibleFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  pk: z.boolean().optional(),
  masked: z.literal(true).optional(),
});
export const VisibleSchemaSchema = z.object({
  collection: z.string(),
  description: z.string(),
  fields: z.array(VisibleFieldSchema),
});

export const CollectionListingSchema = z.object({
  name: z.string(),
  description: z.string(),
  access: z.enum(["granted", "none"]),
  grantedFields: z.number().optional(),
});

// verbs/history.ts
export const ChangeEntrySchema = z.object({
  seq: z.number(),
  collection: z.string(),
  documentId: z.string(),
  rev: z.string(),
  op: z.string(),
  status: z.string(),
  at: z.string(),
  by: z.string(),
});
export const RevisionMetadataSchema = z.object({
  rev: z.string(),
  seq: z.number(),
  at: z.string(),
  by: z.string(),
  op: z.string(),
  status: z.string(),
  fields: z.array(z.string()),
});

// verbs/propose.ts
export const ProposalSummarySchema = z.object({
  proposalId: z.string(),
  collection: z.string(),
  op: z.string(),
  fields: z.array(z.string()),
  proposedBy: z.string(),
  proposedAt: z.string(),
  documentId: z.string(),
});
export const DecisionResultOkSchema = z.object({
  ok: z.literal(true),
  documentId: z.string(),
  rev: z.string(),
  auditId: AuditIdSchema,
});
export const DecisionResultSchema = z.union([DecisionResultOkSchema, MutationRefusalSchema]);

// POST /v1/proposals/decide
export const BatchDecisionsBodySchema = z.object({
  decisions: z.array(z.object({ proposalId: z.string(), action: z.enum(PROPOSAL_ACTIONS) })).min(1),
});
export const BatchDecisionOutcomeSchema = z.union([
  z.object({
    proposalId: z.string(),
    action: z.enum(PROPOSAL_ACTIONS),
    ok: z.literal(true),
    documentId: z.string(),
    rev: z.string().optional(),
    auditId: AuditIdSchema,
  }),
  z.object({
    proposalId: z.string(),
    action: z.enum(PROPOSAL_ACTIONS),
    ok: z.literal(false),
    reason: MutationRefusalReasonSchema,
    auditId: AuditIdSchema,
  }),
]);
export const BatchDecisionOkSchema = z.object({
  ok: z.literal(true),
  batchId: z.string(),
  decisions: z.array(BatchDecisionOutcomeSchema),
});
// The refusal body IS the full batch envelope — the caller needs failedProposalId and the
// per-proposal outcomes, not the bare `{ error }` shape refuse() gives every other route.
export const BatchDecisionRefusalSchema = z.object({
  ok: z.literal(false),
  batchId: z.string(),
  reason: MutationRefusalReasonSchema,
  failedProposalId: z.string().nullable(),
  decisions: z.array(BatchDecisionOutcomeSchema),
});

// POST /v1/batch
export const BatchQueryBodySchema = z.object({
  queries: z.array(QueryIntentSchema.extend({ label: z.string().min(1).max(64) })).min(1),
});
// `results` unions the ok and refusal shapes per label — a refusing sub-query is a normal member
// of the map, not an envelope-level failure. See BatchQueryResult in packages/broker/src/types.ts.
export const BatchQueryOkSchema = z.object({
  ok: z.literal(true),
  results: z.record(z.string(), z.union([BrokerResultOkSchema, RefusalSchema])),
  auditId: AuditIdSchema,
});

// acl/manage.ts
export const DocumentAclSchema = z.object({
  collection: z.string(),
  documentId: z.string(),
  principals: z.array(z.string()),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export const AclResultOkSchema = z.object({
  ok: z.literal(true),
  acl: DocumentAclSchema,
  auditId: AuditIdSchema,
});
export const AclResultSchema = z.union([
  AclResultOkSchema,
  z.object({ ok: z.literal(false), reason: AclRefusalReasonSchema, auditId: AuditIdSchema }),
]);

// Envelopes the routes wrap results in.
export const ChangesResponseSchema = z.object({
  ok: z.literal(true),
  entries: z.array(ChangeEntrySchema),
  auditId: AuditIdSchema,
});
export const RevisionsResponseSchema = z.object({
  ok: z.literal(true),
  revisions: z.array(RevisionMetadataSchema),
  auditId: AuditIdSchema,
});
export const ProposalsResponseSchema = z.object({
  ok: z.literal(true),
  proposals: z.array(ProposalSummarySchema),
  auditId: AuditIdSchema,
});

// GET /v1/grants — `select *` plus three computed fields. additionalProperties stays open on
// purpose: the route spreads whatever columns app.grants has, so a migration widens this
// response without touching the route. See "known warts" in docs/rest-api.md.
export const GrantRowSchema = z
  .object({
    id: z.string(),
    user_id: z.string(),
    collection: z.string(),
    purpose_label: z.string().nullable(),
    purpose_detail: z.string().nullable(),
    allowed_fields: z.array(z.string()).nullable(),
    org_id: z.string(),
    env: z.enum(["dev", "live"]),
    status: z.enum(["pending", "approved", "denied", "revoked"]),
    requested_at: z.string().nullable(),
    decided_at: z.string().nullable(),
    decided_by: z.string().nullable(),
    expires_at: z.string().nullable(),
    document_filter: z.unknown().nullable(),
    verbs: z.array(z.string()),
    mode: z.enum(["direct", "proposal_only"]),
    unmasked_fields: z.array(z.string()),
    principal: z.string().nullable(),
    effectiveStatus: z.string(),
    collectionType: z.string(),
    taxonomyFields: z.array(z.string()),
  })
  .loose();
export const GrantsResponseSchema = z.object({ grants: z.array(GrantRowSchema) });

// POST /v1/grants
export const GrantRequestBodySchema = z.object({
  collection: z.string(),
  purposeLabel: z.string(),
  purposeDetail: z.string().optional(),
  fields: z.array(z.string()).optional(),
});
export const GrantRequestCreatedSchema = z.object({ ok: z.literal(true), requestId: z.string() });

// requestGrant's own validation errors (grants/manage.ts's GrantRequestError) — a distinct type
// from the broker's refusal reasons, never routed through restStatus(). See routes.ts's
// grantRequestErrors flag.
export const GrantRequestErrorSchema = z.object({ error: z.enum(GRANT_REQUEST_ERRORS) });

// PUT /v1/collections/{c}/documents/{id}/acl
export const SetAclBodySchema = z.object({ principals: z.array(z.string()) });

// POST /v1/token — OAuth-standard, a SEPARATE scheme from the broker refusal reasons.
export const TokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number(),
  scope: z.string(),
  issued_token_type: z.string(),
});
export const OAuthErrorSchema = z.object({
  error: z.enum([
    "invalid_request",
    "invalid_client",
    "unauthorized_client",
    "invalid_grant",
    "unsupported_grant_type",
    "server_error",
  ]),
});

// The REST error envelope. Routes answer `{ error: <reason> }`, not the broker's
// `{ ok:false, reason, auditId }` — see refuse() in apps/web/lib/rest.ts.
export const RestErrorSchema = z.object({
  error: z.enum([...ACL_REFUSAL_REASONS, ...MUTATION_REFUSAL_REASONS, "unauthenticated"]),
});
