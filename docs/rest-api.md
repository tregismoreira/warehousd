# REST API (/v1)

A thin HTTP adapter for programmatic access to collections, governed by the same broker that powers the MCP server and web UI. All requests require an access token obtained through one of two flows: `client_credentials` for headless applications, or RFC 8693 `urn:ietf:params:oauth:grant-type:token-exchange` for delegated access on behalf of authenticated users.

## Endpoints

The machine-readable contract is [`docs/openapi.json`](openapi.json), generated from the same zod schemas the routes below enforce and served live at `GET /v1/openapi.json` — request bodies, every documented status, and the reason code behind each 4xx/5xx belong there, not in this table. Browse it rendered at `GET /v1/docs` (a [Scalar](https://github.com/scalar/scalar) reference, unauthenticated like the raw document). This table stays as an at-a-glance index.

| Method | Path | Description |
|---|---|---|
| POST | `/v1/token` | Mint access & refresh tokens via `client_credentials` or token exchange |
| GET | `/v1/collections` | List collection names and descriptions only |
| GET | `/v1/collections/{c}` | Full schema of one collection, granted fields only |
| POST | `/v1/collections/{c}/documents` | Create a document |
| GET | `/v1/collections/{c}/documents/{id}` | Fetch one document, full granted field set |
| PUT | `/v1/collections/{c}/documents/{id}` | Update a document; `If-Match: "{rev}"` for optimistic concurrency |
| DELETE | `/v1/collections/{c}/documents/{id}` | Delete a document |
| GET | `/v1/collections/{c}/documents/{id}/revisions` | Revision history of one document |
| GET | `/v1/collections/{c}/documents/{id}/revisions/{rev}` | One past revision, projected through the caller's current grant and postures |
| GET | `/v1/collections/{c}/documents/{id}/revisions/diff?from=&to=` | The fields that moved between two revisions |
| POST | `/v1/collections/{c}/documents/{id}/revisions/{rev}/revert` | Append a new revision carrying that revision's values. Reads `If-Match`. |
| GET | `/v1/collections/{c}/documents/{id}/acl` | The document's ACL; empty principals means public within the grant. `{id}` is the primary key on a dataset and the url-encoded `path` on a file collection |
| PUT | `/v1/collections/{c}/documents/{id}/acl` | Replace the ACL (`{"principals":["user:…","group:…"]}`); an empty list removes it |
| DELETE | `/v1/collections/{c}/documents/{id}/acl` | Remove the ACL — the document is public within the grant again |
| POST | `/v1/collections/{c}/query` | Structured query: filters, ordering, aggregation, grouping |
| GET | `/v1/collections/{c}/search` | Full-text search over a file collection (query params: `q`, `limit`, `offset`, `fields`) |
| GET | `/v1/proposals` | List pending/approved/rejected proposals (query params: `status`, `collection`) |
| POST | `/v1/proposals/{id}/approve` | Approve a proposal |
| POST | `/v1/proposals/{id}/reject` | Reject a proposal |
| GET | `/v1/changes` | Change feed: document mutations for this workspace/env (query params: `since`, `limit`) |
| GET | `/v1/grants` | List grants for the authenticated user |
| POST | `/v1/grants` | Request access to a collection |

**There is deliberately no `GET /v1/proposals/{id}`.** `listProposals` returns no field values, so reading the *proposed content* of a single proposal is a separate, more privileged call — `broker.getProposal`, reachable only through the console's session route `GET /api/proposals/{id}`. Reviewing proposed content is a console-only surface. Exposing it over `/v1` would be a new public API commitment rather than a gap to close, so it is left to its own decision.

### Revision history

Revision reads apply the grant and the postures **as they are now**, not as they were when the revision was written. A field that was readable last year and is denied today is absent from its own history, and a masked field is masked on both sides of a diff — so a diff of a masked field can read as unchanged even when the value moved. Both follow from the same rule the read path applies: a masked value is never fetched, because a caller who could bisect it could recover it.

### Pagination

`POST /v1/collections/{c}/query` supports two ways to page through a result set, and they answer different questions rather than being interchangeable defaults.

`offset` counts rows from the top of the result set on every call, which is fine for a shallow "page 2 of a UI list" but re-derives its position from scratch each time — a document inserted or deleted ahead of the current page shifts every row behind it, so the next page can repeat a document already seen or silently skip one. It stays the simplest option for paging that does not need to survive concurrent writes.

`after` takes the `nextCursor` a previous response returned and resumes from an exact position instead of a row count, so a walk started with it is correct even while the collection is being written to concurrently — nothing shifts, because the next page is defined by a value, not an offset. A response carries `nextCursor` only when the page came back full; a short page is how the walk ends. `after` and `offset` are mutually exclusive on the same request (`invalid_intent`), and so are `after` and `aggregate` — an aggregate collapses many documents into one row, and there is nothing left to walk.

Three constraints gate `after`, all refusing rather than guessing:

- The collection needs a declared primary key. A collection with none (a file collection, whose identity is `path`) has no total order to page over, so a plain query against one is unaffected — `after` is simply not usable there, and passing it refuses `invalid_intent`.
- The sort field — `orderBy.field`, or the primary key when `orderBy` is omitted — must not be nullable. A `NULL` inside the row-value comparison a cursor builds makes the predicate unknown rather than false, which would drop documents from the walk silently; refusing outright is the safer failure.
- The primary key must be inside the caller's `allowedFields` for a cursor to be issued at all. The cursor carries the primary key's value back on every page, so a caller who cannot read that field is never handed one: the query still returns its documents, and simply comes back with no `nextCursor`. Presenting an `after` cursor without the primary key granted refuses `field_denied`, because resuming a walk is the one request that cannot be answered without it. A grant trimmed to the minimum fields somebody needs therefore still reads — it just reads one page.

The sort field and the primary key are always read for a keyset page, whether or not the caller asked for them, because the next cursor is built from the row that comes back — but they are never added to the documents or `fieldsReturned` the caller did not request. A narrow `fields` list gets exactly the fields it named, and pagination works underneath it regardless.

A cursor is opaque but deliberately not secret and not signed — see the header comment on `packages/broker/src/sql/cursor.ts`. A forged or hand-built cursor decodes to a `(sortField, pk)` pair that becomes a bound-parameter comparison in the same `WHERE` clause as everything else: the grant's document filters, the per-document ACL predicate, and every posture are ANDed in regardless of where the cursor came from, so a forged cursor is no more powerful than a `gt` filter the caller could already write. What a cursor can never do is create a comparison on a masked field — that is enforced the same way `orderBy` on a masked field already is.

**Indexing caveat.** Constant-time page fetches depend on a composite index covering `(sortField, pk)` in the sort direction used. The primary-key-ordered walk is served by the same partial unique index every writable collection already has (`(workspace_id, pk) where _current`), so paging in pk order is constant-time out of the box. Paging by any other field is only constant-time if an operator has indexed that field by hand — nothing warehousd does creates one, and no `warehousd.yml` key declares one. A walk that filters on one field and orders by another — `filter matter_id eq <id>` ordered by `entry_date`, say — needs an index on `(workspace_id, matter_id, entry_date, <pk>)` to get the same guarantee; without it, that walk still returns correct results, just not in constant time per page.

## Response shapes

The three data-returning routes wrap their payload differently, and each shape reads naturally enough on its own that a client written against one is easy to leave silently wrong against another.

**`POST /v1/collections/{c}/documents`** sets `Location` to the new document's URL and returns the mutation result. There is no `ETag` on this response — only `GET` and `PUT` set one (`apps/web/app/v1/collections/[c]/documents/[id]/route.ts`) — so read the new document's revision from `rev` in the body, not from a response header:

```http
HTTP/1.1 201 Created
Location: /v1/collections/pages/documents/3f2e2d10-9b4a-4c1e-8f3a-6d2c9e1b7a52

{
  "ok": true,
  "status": "applied",
  "documentId": "3f2e2d10-9b4a-4c1e-8f3a-6d2c9e1b7a52",
  "rev": "9a1c7e4b-2f0d-4a8e-b6c1-5d3f9e2a1b70",
  "auditId": "b7e2a1c0-4d5f-4e8a-9b3c-1a2d3e4f5b6c"
}
```

**`GET /v1/collections/{c}/documents/{id}`** wraps a single document, keyed `document`, singular, and carries the document's `rev`:

```json
{
  "ok": true,
  "document": { "id": "3f2e2d10-9b4a-4c1e-8f3a-6d2c9e1b7a52", "title": "Q3 roadmap" },
  "fieldsReturned": ["id", "title"],
  "rev": "9a1c7e4b-2f0d-4a8e-b6c1-5d3f9e2a1b70",
  "auditId": "b7e2a1c0-4d5f-4e8a-9b3c-1a2d3e4f5b6c"
}
```

**`POST /v1/collections/{c}/query`** wraps a list, keyed `documents`, plural, and carries no `rev` at all — a result set is not one document to version:

```json
{
  "ok": true,
  "documents": [{ "id": "3f2e2d10-9b4a-4c1e-8f3a-6d2c9e1b7a52", "title": "Q3 roadmap" }],
  "fieldsReturned": ["id", "title"],
  "auditId": "b7e2a1c0-4d5f-4e8a-9b3c-1a2d3e4f5b6c"
}
```

`document`-with-`rev` versus `documents`-without is the detail that gets missed: a client that generates one type from the other's shape, or that reaches for `.rev` after a query the way it does after a fetch, fails silently rather than loudly.

**Every refusal is a bare string under `error`** — never an object, never `{"reason": "..."}`:

```json
{ "error": "not_found" }
```

(`apps/web/lib/rest.ts`, the `refuse()` helper.) The values a client must be prepared to switch on are every member of `RefusalReason` — `no_grant`, `expired_grant`, `field_denied`, `unknown_collection`, `unknown_field`, `invalid_intent`, `internal_error`, `not_found` — plus, on any mutating route, `MUTATION_ONLY_REFUSAL_REASONS`'s additions — `verb_denied`, `verb_not_supported`, `field_not_writable`, `conflict`, `invalid_value`, `not_writable`, `self_approval_denied`, `batch_aborted` (`packages/broker/src/types.ts`). See [Status codes and reasons](#status-codes-and-reasons) below for which HTTP status each one maps to.

## Known warts

The spec documents these two shapes faithfully rather than prettying them up, so they are recorded here as known rather than surprising.

- **`GET /v1/collections/{c}/search` accepts no `mode`.** The route builds its search intent without one (`apps/web/app/v1/collections/[c]/search/route.ts`), so semantic and hybrid search are reachable over MCP's `search_documents` only, never over `/v1`. The query parameters the route actually reads are `q`, `fields`, `limit`, `offset`.
- **`GET /v1/grants` is a `select *` from `app.grants`.** The response is every column that table has today, plus three computed fields (`effectiveStatus`, `collectionType`, `taxonomyFields`), and the spec's schema deliberately leaves `additionalProperties: true` open on it — a future migration that adds a column widens this response with no code change and no spec change to catch it.
- **`/v1/platform/workspaces/...` is entirely absent from the spec.** It is a separate control-plane API — bearer-token auth via `derivePlatformCaller`, not OAuth; hand-rolled JSON error bodies, not `RefusalReason`; no zod schema anywhere in the five routes under `apps/web/app/v1/platform/`. This generator only derives a schema from a route's own enforced validation, so there is nothing to source from without hand-writing shapes that would drift from the routes instead of being generated from them.

## Status codes and reasons

All refusals return a `reason` code; never a denied field value, never SQL. `/v1/token` uses a separate, OAuth-standard error-code scheme (`invalid_request`, `invalid_client`, `unauthorized_client`, `invalid_grant`, `unsupported_grant_type`, `slow_down`, `invalid_scope`, `server_error`) rather than the broker refusal reasons below — the two tables do not share a mapping function.

**Data routes** (`/v1/collections/...`, `/v1/proposals/...`, `/v1/grants`, `/v1/changes`) — mapped by `restStatus()`:

| Code | Refusal reason | Explanation |
|---|---|---|
| **2xx** | — | Success; response carries documents or metadata. |
| 201 | (success) | Document created (mutation applied immediately). |
| 202 | (success) | Mutation accepted but pending approval (stored as a proposal). |
| 204 | (success) | Document deleted (direct mode), or a revert whose target revision is already the current one — both with no body per RFC 7231. |
| 400 | `invalid_intent`, `invalid_value` | Malformed query or mutation. |
| 401 | `unauthenticated` | Missing or invalid access token. |
| 403 | `no_grant`, `expired_grant`, `field_denied`, `verb_denied`, `field_not_writable`, `acl_denied` | Access denied: no grant, expired grant, field/verb not granted, field is not writable, or the client's policy does not carry `can_manage_acl`. |
| 404 | `unknown_collection`, `unknown_field`, `not_found` | Collection, field, or document does not exist, or is excluded by a document filter. |
| 405 | `verb_not_supported`, `not_writable` | Operation not supported on this collection type (e.g., update on a file collection). |
| 409 | `conflict` | Mutation conflicts with an existing value (no `If-Match` header provided). |
| 412 | `conflict` | Optimistic concurrency mismatch: document's `_rev` does not match the `If-Match` header. |
| 500 | `internal_error` | Server error; reason code only — no details exposed. |

**`POST /v1/token`** — OAuth-standard error codes, not `restStatus()`:

| Code | Error | Explanation |
|---|---|---|
| 200 | — | Token issued. |
| 400 | `invalid_request` | Malformed request (missing/duplicate parameters, both Basic and form-field client auth present). |
| 400 | `unauthorized_client` | Grant type doesn't match the client's mode (e.g. a `delegated` client using `client_credentials`). |
| 400 | `invalid_grant` | Subject token invalid, issuer unregistered, or subject unresolvable/cross-workspace. |
| 400 | `unsupported_grant_type` | `grant_type` is neither `client_credentials` nor the token-exchange URN. |
| 400 | `invalid_scope` | The client's policy allows no environment the caller can be issued. |
| 401 | `invalid_client` | Client authentication failed. |
| 429 | `slow_down` | Too many attempts for this `client_id`; `retry-after` names the wait in seconds. |
| 500 | `server_error` | Token could not be minted; reason code only — no details exposed. |

**Special case: conflict detection.** A mutation with an `If-Match: "{rev}"` header that conflicts returns 412 (Precondition Failed), while a conflict without the header returns 409 (Conflict). Both carry `reason: "conflict"` in the JSON response body.

Approving a proposal can also return 409: either the proposal overlaps a field changed since it was derived, or the document it creates came into existence in the meantime and the promotion lost the race for the current-revision index. Both are retriable by re-reading and re-proposing, which is why they are not 500.

## Authentication: client_credentials flow (headless applications)

For an application running without a user context.

**1. Request a token:**

```http
POST /v1/token HTTP/1.1
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(client_id:client_secret)

grant_type=client_credentials&scope=env:live
```

Or using form-field credentials (less secure, form auth):

```http
POST /v1/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=...
&client_secret=...
&scope=env:live
```

**2. Response:**

```json
{
  "access_token": "hex_string_32_bytes",
  "token_type": "Bearer",
  "expires_in": 900,
  "scope": "env:live",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token"
}
```

**3. Use the token:**

```http
GET /v1/collections HTTP/1.1
Authorization: Bearer {access_token}
```

**`via` derivation:** Headless clients use `api_key:{clientId}` in the broker context, visible in audit events.

## Authentication: token-exchange flow (delegated access)

For an application representing an authenticated end user under their own grants.

**1. Obtain a subject token** from your IdP (e.g., Cognito, Auth0, Keycloak). This is an external OIDC/SAML token asserting the user's identity.

**2. Exchange it for a warehousd access token:**

```http
POST /v1/token HTTP/1.1
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(client_id:client_secret)

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token={subject_token_from_idp}
&subject_token_type=urn:ietf:params:oauth:token-type:jwt
&scope=env:live
```

**3. Response:** Same as `client_credentials` above.

**4. Use the token:** Same as headless flow.

**Requirements:**

- The delegated client's policy must have a `trustedIssuerId` registered, pointing to a trusted issuer configuration with the IdP's JWKS URI, issuer identifier, and audience.
- The subject token's subject claim (default `sub`, customizable per issuer) must match a user email in the workspace.
- The user must hold a live grant to receive `env:live` scope; otherwise only `env:dev` is issued.

**`via` derivation:** Delegated clients that have registered secrets use `token_exchange` in the broker context. Those without secrets and using interactive OAuth flows use `oauth`.

## Platform API (/v1/platform)

A control plane above the workspace boundary, for a consuming application to provision and manage workspaces and their OAuth clients programmatically — not part of the data plane, and not reachable with a session cookie or an OAuth/MCP token. Every route is mounted only when `workspaces.enabled: true`; with the flag off, every path and method under `/v1/platform` returns a body-less **404**, indistinguishable from a route that does not exist, so a probe against the namespace cannot tell "not mounted" from "no such workspace."

**Authentication:** `Authorization: Bearer <platform key secret>`, minted by `warehousd platform-key create` (see [cli.md](cli.md)). Not a session, not an OAuth client — a platform key is its own credential, verified against `app.platform_keys` (salted, hashed with `scrypt`). A key is either unrestricted (`managed_workspaces: null`, every workspace) or scoped to specific workspace ids; a call naming a workspace outside that scope gets the same 404 a nonexistent workspace would, so a scoped key cannot enumerate tenants it does not manage. A missing or invalid bearer token gets `401 {"error":"unauthenticated"}` instead — the only way to tell "not mounted" (404) from "mounted, but you're not who you say you are" (401).

| Method | Path | Description | Success status |
|---|---|---|---|
| POST | `/v1/platform/workspaces` | Create a workspace (`{id, name, admin: {userId}}`); the named user becomes its first admin. `409 workspace_exists` if the id is taken. | 201 |
| GET | `/v1/platform/workspaces` | List workspaces the key manages (every one, if unrestricted) | 200 |
| GET | `/v1/platform/workspaces/{id}` | Fetch one workspace | 200 |
| DELETE | `/v1/platform/workspaces/{id}` | Delete a workspace: every declared table's rows in both `data_synth` and `data_live`, then the `app.workspaces` row itself. Grants and client policies cascade from the row; `app.audit_events` does not — a deleted workspace's audit trail survives it, naming an id nothing else references any more. | 204 |
| POST | `/v1/platform/workspaces/{id}/seed` | Regenerate `dev` synthetic data for the workspace (`{seed?}`, default 42) — the same operation `warehousd seed` performs, scoped to this one workspace. `dev` only; there is no `live` counterpart, by the same reasoning `warehousd seed` never touches `live`. | 200 |
| POST | `/v1/platform/workspaces/{id}/clients` | Provision an OAuth client pinned to this workspace and mint its first secret in one call (`{displayName?, env?, days?}`) — the platform counterpart to the console's "new client" flow, for a caller with no console to click through. The secret is returned once and never again. | 201 |
| GET | `/v1/platform/workspaces/{id}/members` | List the workspace's members and roles | 200 |
| POST | `/v1/platform/workspaces/{id}/members` | Set a member's role (`{userId, role}`); creates the membership if absent | 200 |
| DELETE | `/v1/platform/workspaces/{id}/members?userId=…` | Remove a member. `409 last_admin` if they are the workspace's only admin. | 204 |

Every mutation is audited through the same `makeAuditWriter` every other decision in the deployment uses — never a hand-written insert — with `userId: "platform:<keyId>"`, `via: "platform_key:<keyId>"`, and `collection: null` marking it an operational rather than a data event.

A caller that names a workspace the key does not manage — unknown id, or outside a scoped key's `managed_workspaces` — gets the same `404 {"error":"not_found"}` a nonexistent workspace would, never a 403: confirming a workspace exists is exactly the enumeration a scoped key must not be able to do against a tenant that isn't its own.

## What this is not

This REST adapter is optimized for **low-complexity, governance-heavy access**, not for high-throughput queries, real-time data pipelines, or sub-field mutations.

- **No high throughput.** Access tokens are short-lived (15 minutes); refresh requires re-evaluation of grants and can be slow. This is intentional — real-time data pipelines should read `data_live` directly as a privilege-bearing role, not through a governance layer.
- **No sub-50ms latency.** Every request reloads grants and re-validates against them; latency is typically 50–200ms per request, including database round-trips. Batch-oriented workflows that can tolerate this are the target use case.
- **No anonymous reads.** Every request requires an authenticated token (either app or user). A public dataset must either be exported separately or put behind a separate, ungovened read path.
- **No relational expressiveness.** The query API supports filters, ordering, aggregation, and grouping, but not joins. Collections are flat by design; cross-collection navigation is not in the broker and will not be.
- **No sub-field granularity.** The smallest unit of governance is a field; there is no per-element access control within one. Documents are governed as whole documents — by a grant's document filter, and on a collection declaring `acl: true` by the per-document ACL routes above.
- **No cross-collection atomicity.** A mutation affects one collection only. Multi-collection transactions do not exist; eventual consistency is the deployment model for changes that span collections.
