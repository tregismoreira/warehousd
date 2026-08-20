import { z } from "zod";
import { restStatus } from "../rest";
import { OPERATIONS, type Operation } from "./routes";
import * as R from "./responses";

// Builds the OpenAPI 3.1 document from OPERATIONS (routes.ts) and the response schemas
// (responses.ts). Used by scripts/api-spec.ts (the CLI) and apps/web/test/api-spec.test.ts (the
// regeneration gate) — kept separate from both so the test can build in memory without writing a
// file, and so this module never needs `next`, `pg`, or a database.
//
// Spike findings (see plan Phase 1.1 — recorded here because they shape everything below):
//   - z.unknown() (a filter's `value`) renders as `{}` — the empty schema, "anything".
//   - z.record(Ident, z.unknown()) (MutationValues) renders as
//     `{ type: "object", propertyNames: { pattern: "^[a-z_][a-z0-9_]*$" }, additionalProperties: {} }`.
//     Kept as-is (propertyNames is correct, if less universally supported than a flattened
//     `additionalProperties: true`) rather than flattened, per the plan's recommendation.
//   - GetDocumentIntentSchema (z.union of two objects) renders as `anyOf`.
//   - MutationIntentSchema (z.discriminatedUnion) renders as `oneOf`, and `.options` (not
//     `.def.options`) yields the three branches directly, in create/update/delete order.
//   - Every schema emits its own `$schema` key. Stripped per-schema below; the dialect is
//     declared once at the document root via `jsonSchemaDialect` instead (OpenAPI 3.1's own
//     mechanism — no per-schema `$schema` key survives).
//   - z.number().int() with no explicit bounds renders `minimum`/`maximum` at the JS safe-integer
//     range (±9007199254740991). That is an incidental type-safety bound, not the business cap —
//     `limit`/`offset` carry no artificial "maximum": 500 in the schema on purpose, so an oversized
//     limit is documented in prose as clamped, never rejected (buildSelect's Math.min/Math.max).

function toSchema(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: "draft-2020-12", io }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

// Every response/request-body schema referenced by name in routes.ts, registered once so a
// schema used by more than one operation ($ref) is not repeated, and inlined only where routes.ts
// builds a schema inline (a genuine one-off: the free-form mutation bodies, the token form body,
// the omitted-collection query body).
const NAMED_SCHEMAS: { name: string; schema: z.ZodType; io: "input" | "output" }[] = [
  { name: "TokenResponse", schema: R.TokenResponseSchema, io: "output" },
  { name: "VisibleSchema", schema: R.VisibleSchemaSchema, io: "output" },
  { name: "BrokerResultOk", schema: R.BrokerResultOkSchema, io: "output" },
  { name: "MutationApplied", schema: R.MutationAppliedSchema, io: "output" },
  { name: "MutationPending", schema: R.MutationPendingSchema, io: "output" },
  { name: "GetDocumentResultOk", schema: R.GetDocumentResultOkSchema, io: "output" },
  { name: "RevisionsResponse", schema: R.RevisionsResponseSchema, io: "output" },
  { name: "AclResultOk", schema: R.AclResultOkSchema, io: "output" },
  { name: "ProposalsResponse", schema: R.ProposalsResponseSchema, io: "output" },
  { name: "DecisionResultOk", schema: R.DecisionResultOkSchema, io: "output" },
  { name: "BatchDecisionsBody", schema: R.BatchDecisionsBodySchema, io: "input" },
  { name: "BatchDecisionOutcome", schema: R.BatchDecisionOutcomeSchema, io: "output" },
  { name: "BatchDecisionOk", schema: R.BatchDecisionOkSchema, io: "output" },
  { name: "BatchDecisionRefusal", schema: R.BatchDecisionRefusalSchema, io: "output" },
  { name: "ChangesResponse", schema: R.ChangesResponseSchema, io: "output" },
  { name: "GrantsResponse", schema: R.GrantsResponseSchema, io: "output" },
  { name: "GrantRequestCreated", schema: R.GrantRequestCreatedSchema, io: "output" },
  { name: "GrantRequestBody", schema: R.GrantRequestBodySchema, io: "input" },
  { name: "SetAclBody", schema: R.SetAclBodySchema, io: "input" },
  { name: "OAuthError", schema: R.OAuthErrorSchema, io: "output" },
  { name: "GrantRequestError", schema: R.GrantRequestErrorSchema, io: "output" },
];

const schemaRefName = new Map<z.ZodType, string>(NAMED_SCHEMAS.map((e) => [e.schema, e.name]));

function refOrInline(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const name = schemaRefName.get(schema);
  return name ? { $ref: `#/components/schemas/${name}` } : toSchema(schema, io);
}

function unauthenticatedResponse(): Record<string, unknown> {
  return {
    description: "Missing or invalid access token.",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: { error: { type: "string", const: "unauthenticated" } },
          required: ["error"],
        },
      },
    },
  };
}

function narrowedErrorSchema(reasons: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: { error: { type: "string", enum: [...reasons].sort() } },
    required: ["error"],
  };
}

function headersFor(names: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const h of names) {
    out[h] =
      h === "Location"
        ? { description: "The created document's URL.", schema: { type: "string" } }
        : {
            description: 'The document\'s rev, quoted per RFC 7232 (e.g. "abc123").',
            schema: { type: "string" },
          };
  }
  return out;
}

function buildResponses(op: Operation): Record<string, unknown> {
  const responses: Record<string, unknown> = {};

  for (const s of op.success) {
    responses[String(s.status)] = {
      description: s.description,
      ...(s.schema
        ? { content: { "application/json": { schema: refOrInline(s.schema, "output") } } }
        : {}),
      ...(s.headers?.length ? { headers: headersFor(s.headers) } : {}),
    };
  }

  if (op.oauthErrors) {
    // /v1/token never reaches restStatus() — a separate, OAuth-standard error scheme. 429
    // (slow_down) and the 400 invalid_scope case are real responses this route sends that the
    // plan's original 6-code table omitted; both are OAuthError-shaped, so no separate schema.
    for (const status of [400, 401, 429, 500]) {
      responses[String(status)] = {
        description:
          status === 429
            ? "Rate limited. `retry-after` names the wait in seconds."
            : "OAuth-standard error.",
        content: { "application/json": { schema: refOrInline(R.OAuthErrorSchema, "output") } },
      };
    }
    return responses;
  }

  if (op.grantRequestErrors) {
    responses["404"] = {
      description: "The collection does not exist.",
      content: {
        "application/json": {
          schema: { ...refOrInline(R.GrantRequestErrorSchema, "output") },
        },
      },
    };
    responses["400"] = {
      description: "The request could not be validated.",
      content: { "application/json": { schema: refOrInline(R.GrantRequestErrorSchema, "output") } },
    };
    responses["401"] = unauthenticatedResponse();
    return responses;
  }

  // Group refusal reasons by the status restStatus() gives them. `conflict` on a `conditional`
  // operation appears twice — 409 without If-Match, 412 with it — both carrying the same reason;
  // that is the split the route itself makes (refuse(reason, !!ifMatch)), not a choice made here.
  const byStatus = new Map<number, Set<string>>();
  const add = (status: number, reason: string) => {
    if (!byStatus.has(status)) byStatus.set(status, new Set());
    byStatus.get(status)!.add(reason);
  };
  for (const reason of op.reasons) {
    add(restStatus(reason, false), reason);
    if (op.conditional && reason === "conflict") add(restStatus(reason, true), reason);
  }

  for (const [status, reasons] of byStatus) {
    const list = [...reasons];
    let description = `Refusal: ${list.join(", ")}.`;
    if (status === 409) description = "Conflict — no If-Match header was sent. reason: conflict.";
    if (status === 412)
      description =
        "Optimistic concurrency mismatch — If-Match did not match the document's current rev. reason: conflict.";
    responses[String(status)] = {
      description,
      content: { "application/json": { schema: narrowedErrorSchema(list) } },
    };
  }

  responses["401"] = unauthenticatedResponse();
  return responses;
}

// z.number().int() with no explicit bound renders minimum/maximum at the JS safe-integer range
// (±9007199254740991) — an incidental type-safety artifact, not a declared business bound. None
// of this API's integer query parameters (limit, offset, since) has a real one: the actual cap
// (buildSelect's Math.min/Math.max, 500) clamps rather than rejects, and is stated in prose, never
// enforced as a schema "maximum" that would make an oversized value look like a validation error.
const SAFE_INT_BOUND = 9007199254740991;
function stripIncidentalIntBounds(schema: Record<string, unknown>): Record<string, unknown> {
  const { minimum, maximum, ...rest } = schema;
  const isSafeIntBound = minimum === -SAFE_INT_BOUND && maximum === SAFE_INT_BOUND;
  return isSafeIntBound ? rest : schema;
}

function buildParameters(op: Operation): Record<string, unknown>[] {
  return (op.params ?? []).map((p) => ({
    name: p.name,
    in: p.in,
    required: p.in === "path" ? true : (p.required ?? false),
    description: p.description,
    schema: stripIncidentalIntBounds(toSchema(p.schema, "input")),
    ...(p.style ? { style: p.style } : {}),
    ...(p.explode !== undefined ? { explode: p.explode } : {}),
  }));
}

function buildRequestBody(op: Operation): Record<string, unknown> | undefined {
  if (!op.requestBody) return undefined;
  const mediaType =
    op.operationId === "mintToken" ? "application/x-www-form-urlencoded" : "application/json";
  return {
    required: true,
    description: op.requestBody.description,
    content: { [mediaType]: { schema: refOrInline(op.requestBody.schema, "input") } },
  };
}

function buildOperation(op: Operation): Record<string, unknown> {
  const parameters = buildParameters(op);
  const requestBody = buildRequestBody(op);
  return {
    operationId: op.operationId,
    summary: op.summary,
    tags: op.tags,
    ...(parameters.length ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: buildResponses(op),
    ...(op.oauthErrors ? { security: [{ basicAuth: [] }] } : {}),
  };
}

function buildPaths(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    const forPath = (paths[op.path] ??= {});
    forPath[op.method] = buildOperation(op);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(paths).sort()) sorted[key] = paths[key];
  return sorted;
}

function buildComponentSchemas(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of [...NAMED_SCHEMAS].sort((a, b) => a.name.localeCompare(b.name))) {
    out[entry.name] = toSchema(entry.schema, entry.io);
  }
  return out;
}

// This deployment's own release version (packages/cli/package.json) — a fact about the product,
// not a value derived from Date or process.env, so regeneration stays deterministic.
const API_VERSION = "0.1.0-rc.1";

export function buildOpenApiDoc(): Record<string, unknown> {
  return {
    openapi: "3.1.1",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "REST API (/v1)",
      version: API_VERSION,
      description:
        "A thin HTTP adapter for programmatic access to collections, governed by the same " +
        "broker that powers the MCP server and web UI.",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    },
    servers: [
      {
        url: "{baseUrl}",
        variables: {
          baseUrl: {
            default: "http://localhost:8722",
            description: "This deployment's BETTER_AUTH_URL.",
          },
        },
      },
    ],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "auth", description: "Minting an access token." },
      { name: "collections", description: "Discovering what a caller may read." },
      { name: "data", description: "Reading, searching, and mutating documents." },
      { name: "history", description: "Revisions and the org/env change feed." },
      {
        name: "acl",
        description:
          "Per-document access control. Authorised against the caller's standing, not a grant.",
      },
      {
        name: "proposals",
        description:
          "Deciding on a pending write. There is deliberately no GET /v1/proposals/{id} — " +
          "reviewing a proposal's proposed content is a console-only surface, not part of this " +
          "public commitment.",
      },
      { name: "grants", description: "Requesting and listing access grants." },
    ],
    paths: buildPaths(),
    components: {
      schemas: buildComponentSchemas(),
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        basicAuth: { type: "http", scheme: "basic" },
      },
    },
  };
}
