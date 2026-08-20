# MCP (`/mcp`)

MCP has no OpenAPI equivalent. There is no schema-description standard for a JSON-RPC tool surface the way OpenAPI 3.1 describes a REST one, so the machine-readable contract is the `tools/list` payload the server itself answers — and `docs/mcp-tools.json` is that payload, verified against the running server by `apps/web/test/mcp-manifest.test.ts`. That is why this file reads differently from [`docs/rest-api.md`](rest-api.md): there is no generated spec to link to, only a committed copy of what the server actually says, proven equal to it.

## Transport and auth

One endpoint, `POST /mcp` (`GET` and `DELETE` are also handled, for client compatibility). Stateless streamable HTTP: a fresh `Server` and `WebStandardStreamableHTTPServerTransport` per request, from `@modelcontextprotocol/sdk` `^1.30.0` — a `Server` can only be connected to one transport at a time, so a shared module-level instance would race under concurrent requests.

Every call carries a bearer token. A missing or invalid one answers 401 with a `WWW-Authenticate: Bearer resource_metadata="{baseUrl}/.well-known/oauth-protected-resource"` header, and a client discovers the rest from there:

- `/.well-known/oauth-protected-resource` (RFC 9728)
- `/.well-known/oauth-authorization-server` (RFC 8414)

`{baseUrl}` is always the deployment's `BETTER_AUTH_URL`, never the request's `Host` header — a connector URL derived from an attacker-controlled header would send a user's OAuth flow somewhere else.

## Response envelope

A tool call answers over SSE by default — `content-type: text/event-stream`, one `event: message` frame whose `data:` line carries the JSON-RPC response — because `enableJsonResponse` on the streamable HTTP transport defaults to false; a client sending `accept: application/json, text/event-stream` still gets this framing rather than a bare JSON body. Reaching the tool's own result takes a second parse on top of that: the JSON-RPC envelope's `result.content[0].text` is a **stringified JSON string** — the broker result, `JSON.stringify`-ed into the one `text` field of an MCP content block (`apps/web/app/mcp/route.ts`) — not the result itself.

For a list-returning tool such as `search_documents` or `query_collection`, that inner JSON is a `BrokerResult`, keyed `documents`, plural (`packages/broker/src/types.ts`, advertised through `apps/web/lib/mcp-tools.ts`) — `get_document` instead returns a `GetDocumentResult` keyed `document`, singular, the same distinction [`docs/rest-api.md`](rest-api.md#response-shapes) documents for the REST adapter's matching routes, because both adapters wrap the same broker results.

The two-step parse, mirroring the `rpc()` helper in `apps/web/test/mcp-endpoint.integration.test.ts`:

```ts
const sseBody = await res.text();
const dataLine = sseBody.split("\n").find((l) => l.startsWith("data: "))!;
const rpcEnvelope = JSON.parse(dataLine.slice(6));
const toolResult = JSON.parse(rpcEnvelope.result.content[0].text);
// toolResult.documents is the array `search_documents` and `query_collection` return;
// toolResult.ok, toolResult.fieldsReturned and toolResult.auditId sit beside it.
```

## The tools

Nine tools. Every refusal (`ok: false`) carries a `hint` pointing at `request_access` — the model reading it is the first consumer of the governance model, not an afterthought.

| Tool | What it does | Refusal reasons |
|---|---|---|
| `list_collections` | Names, descriptions, and the caller's own access — `granted`/`none` — to each. No schema, no other caller's access. | `internal_error` |
| `describe_collection` | Schema of fields visible under the caller's grants. | `no_grant`, `expired_grant`, `unknown_collection`, `invalid_intent`, `internal_error`, `field_denied` |
| `query_collection` | Structured query: filters, ordering, aggregation, grouping — re-validated against the grant, then executed. | `no_grant`, `expired_grant`, `unknown_collection`, `invalid_intent`, `internal_error`, `field_denied`, `unknown_field` |
| `search_documents` | Ranked search. Naming a collection searches it; omitting one fans out across every collection the caller may read and merges by reciprocal-rank fusion. | `no_grant`, `expired_grant`, `unknown_collection`, `invalid_intent`, `internal_error`, `field_denied`, `unknown_field` |
| `get_document` | Fetch one document by id or path. | `no_grant`, `expired_grant`, `unknown_collection`, `invalid_intent`, `internal_error`, `field_denied`, `not_found` |
| `create_document` | Create a document in a writable collection. May return `status: "pending"` — invisible until a human approves it. | `no_grant`, `expired_grant`, `unknown_collection`, `invalid_intent`, `internal_error`, `verb_denied`, `field_not_writable`, `invalid_value`, `not_writable`, `verb_not_supported`, `conflict` |
| `update_document` | Update an existing document. May return `status: "pending"`. | as `create_document`, plus `not_found` |
| `delete_document` | Delete a document. May return `status: "pending"`. | as `create_document`, plus `not_found` |
| `request_access` | Open a pending grant request for a manager or admin to approve. Its own error set — `GrantRequestError`, not a broker refusal reason. | `unknown_collection`, `purpose_required`, `field_not_grantable`, `invalid_principal` |

`docs/mcp-tools.json` carries the full advertised `inputSchema` for each — generated from the same zod schema the handler parses against (`apps/web/lib/mcp-tools.ts`'s `advertise()`), with one deliberate exception: `get_document`'s schema is a union of two shapes (`id` XOR `path`), which renders as `anyOf` in JSON Schema. Advertising that degrades tool-call quality for a constraint the handler enforces anyway, so `get_document` keeps a flat, hand-written schema instead — pinned by a test so it cannot rot silently.

## What is deliberately absent

- **No `approve`/`reject` tools.** The model may propose a write; it may not decide on one, including someone else's. Adding these would not by itself let a model approve its own proposal — the broker refuses `self_approval_denied` against the proposal's author regardless — but it would let it approve *another* proposer's, which is not a decision an untrusted party gets to make.
- **No ACL tools.** A tool the model can call is a tool that can widen who else may read something. Per-document ACLs are managed over `/v1` only, authorised against the caller's standing rather than a grant.
- **No resources, no prompts.** Only tools are exposed.
- **No client-supplied vector on search.** The vector is always derived server-side from `q`. A client-supplied one would be an oracle: a caller could probe the embedding space of documents their grant excludes, reading similarity out of a corpus they cannot read.
- **Unknown keys are dropped, not refused.** A forged `env`, `orgId`, or `userId` in a tool's arguments is silently ignored — every one of the three comes from the verified token, never from the call. Rejecting a forged key would itself leak that the parameter was read at all; dropping it does not. `apps/web/test/mcp-endpoint-acceptance.integration.test.ts`'s "env wall over MCP" suite (§10 test 5) forges `env: "live"` into every tool's arguments and requires the call to *succeed*, against dev data only — a forged parameter has to be provably inert, not merely rejected.
