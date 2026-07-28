# REST API (/v1)

A thin HTTP adapter for programmatic access to collections, governed by the same broker that powers the MCP server and web UI. All requests require an access token obtained through one of two flows: `client_credentials` for headless applications, or RFC 8693 `urn:ietf:params:oauth:grant-type:token-exchange` for delegated access on behalf of authenticated users.

## Endpoints

| Method | Path | Broker call | Description | Success status |
|---|---|---|---|---|
| POST | `/v1/token` | (auth, not a broker call) | Mint access & refresh tokens via `client_credentials` or token exchange | 200 |
| GET | `/v1/collections` | `listCollections` | List collection names and descriptions only | 200 |
| GET | `/v1/collections/{c}` | `describeCollection` | Full schema of one collection, granted fields only | 200 |
| POST | `/v1/collections/{c}/documents` | `mutate` (create) | Create a document | 201 (direct), 202 (pending) |
| GET | `/v1/collections/{c}/documents/{id}` | `getDocument` | Fetch one document, full granted field set | 200 |
| PUT | `/v1/collections/{c}/documents/{id}` | `mutate` (update) | Update a document; `If-Match: "{rev}"` for optimistic concurrency | 200 (direct), 202 (pending), 409/412 (conflict) |
| DELETE | `/v1/collections/{c}/documents/{id}` | `mutate` (delete) | Delete a document | 204 (direct), 202 (pending) |
| GET | `/v1/collections/{c}/documents/{id}/revisions` | `listRevisions` | Revision history of one document | 200 |
| POST | `/v1/collections/{c}/query` | `query` | Structured query: filters, ordering, aggregation, grouping | 200 |
| GET | `/v1/collections/{c}/search` | `searchDocuments` | Full-text search over a file collection (query params: `q`, `limit`, `offset`, `fields`) | 200 |
| GET | `/v1/proposals` | `listProposals` | List pending/approved/rejected proposals (query params: `status`, `collection`) | 200 |
| POST | `/v1/proposals/{id}/approve` | `approveProposal` | Approve a proposal | 200 |
| POST | `/v1/proposals/{id}/reject` | `rejectProposal` | Reject a proposal | 200 |
| GET | `/v1/changes` | `changes` | Change feed: document mutations for this org/env (query params: `since`, `limit`) | 200 |
| GET | `/v1/grants` | (custom) | List grants for the authenticated user | 200 |
| POST | `/v1/grants` | (custom) | Request access to a collection | 201 |

## Status codes and reasons

All refusals return a `reason` code; never a denied field value, never SQL. `/v1/token` uses a
separate, OAuth-standard error-code scheme (`invalid_request`, `invalid_client`,
`unauthorized_client`, `invalid_grant`, `unsupported_grant_type`, `server_error`) rather than the
broker refusal reasons below — the two tables do not share a mapping function.

**Data routes** (`/v1/collections/...`, `/v1/proposals/...`, `/v1/grants`, `/v1/changes`) — mapped by `restStatus()`:

| Code | Refusal reason | Explanation |
|---|---|---|
| **2xx** | — | Success; response carries documents or metadata. |
| 201 | (success) | Document created (mutation applied immediately). |
| 202 | (success) | Mutation accepted but pending approval (stored as a proposal). |
| 204 | (success) | Document deleted (direct mode) with no body per RFC 7231. |
| 400 | `invalid_intent`, `invalid_value` | Malformed query or mutation. |
| 401 | `unauthenticated` | Missing or invalid access token. |
| 403 | `no_grant`, `expired_grant`, `field_denied`, `verb_denied`, `field_not_writable` | Access denied: no grant, expired grant, field/verb not granted, or field is not writable. |
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
| 400 | `invalid_grant` | Subject token invalid, issuer unregistered, or subject unresolvable/cross-org. |
| 400 | `unsupported_grant_type` | `grant_type` is neither `client_credentials` nor the token-exchange URN. |
| 401 | `invalid_client` | Client authentication failed. |
| 500 | `server_error` | Token could not be minted; reason code only — no details exposed. |

**Special case: conflict detection.** A mutation with an `If-Match: "{rev}"` header that conflicts returns 412 (Precondition Failed), while a conflict without the header returns 409 (Conflict). Both carry `reason: "conflict"` in the JSON response body.

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
- The subject token's subject claim (default `sub`, customizable per issuer) must match a user email in the organization.
- The user must hold a live grant to receive `env:live` scope; otherwise only `env:dev` is issued.

**`via` derivation:** Delegated clients that have registered secrets use `token_exchange` in the broker context. Those without secrets and using interactive OAuth flows use `oauth`.

## What this is not

This REST adapter is optimized for **low-complexity, governance-heavy access**, not for high-throughput queries, real-time data pipelines, or sub-field mutations.

- **No high throughput.** Access tokens are short-lived (15 minutes); refresh requires re-evaluation of grants and can be slow. This is intentional — real-time data pipelines should read `data_live` directly as a privilege-bearing role, not through a governance layer.
- **No sub-50ms latency.** Every request reloads grants and re-validates against them; latency is typically 50–200ms per request, including database round-trips. Batch-oriented workflows that can tolerate this are the target use case.
- **No anonymous reads.** Every request requires an authenticated token (either app or user). A public dataset must either be exported separately or put behind a separate, ungovened read path.
- **No relational expressiveness.** The query API supports filters, ordering, aggregation, and grouping, but not joins. Collections are flat by design; cross-collection navigation is not in the broker and will not be.
- **No sub-document granularity.** The smallest unit of governance is a field; there is no per-document or per-element access control. Field-level grants are the floor.
- **No cross-collection atomicity.** A mutation affects one collection only. Multi-collection transactions do not exist; eventual consistency is the deployment model for changes that span collections.
