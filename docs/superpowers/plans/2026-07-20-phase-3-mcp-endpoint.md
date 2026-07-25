# Phase 3 — MCP Endpoint (Execution Outline)

> **Status: executed.** Spec: `docs/SPECS.md` §7. Roadmap: Phase 3.

**Goal:** OAuth-protected `/mcp` streamable-HTTP endpoint exposing the five governed tools, with `BrokerContext` derived exclusively from the verified token.

**Depends on:** Phase 2 (tokens). Phase 0.5 (`searchDocuments`).

## Tasks

- [x] `/mcp` streamable-HTTP endpoint (MCP TypeScript SDK) in `mvp/apps/web`, OAuth-protected; `BrokerContext` via `lib/broker-context.ts` (Phase 2) — no other construction path
- [x] Tools (complete list): `list_collections`, `describe_collection(name)`, `query_collection(intent)`, `search_documents(collection, q)` (§5.6.3), `request_access(collection, purpose, fields?)`
- [x] `request_access` creates a `pending` grant row (via `requestGrant`) and returns the request id
- [x] Refusals from `describe_collection`/`query_collection`/`search_documents` include the `request_access` hint; tool descriptions state deny-by-default + purpose-bound governance plainly (the model reading them is the first consumer of the security posture)
- [x] Shared tool module `mvp/apps/web/lib/mcp-tools.ts`: tool defs + handlers used by **both** the MCP endpoint and the chat console's tool loop (console becomes a local MCP test bench; chat route rewired onto the shared implementations)

**Key files:** `mvp/apps/web/app/mcp/route.ts` (or `app/api/mcp/route.ts`), `mvp/apps/web/lib/mcp-tools.ts`, modify `mvp/apps/web/app/api/chat/route.ts`.

## Acceptance gate

- [x] MCP-over-HTTP integration tests with a dev token: `list_collections` returns names+descriptions only; `describe_collection` grant-filtered; probe-suite hostile intents through `query_collection` **and** `search_documents` refused with reason codes and zero canary leakage; `search_documents` grant-filtered with `_rank`/`document_seq` (the field is `document_seq`, not `chunk_index` as originally written here); `request_access` produces a pending grant row.
- [x] Env wall over MCP: dev-token session never returns live canaries (structured + document) across all five tools; forged env values in tool args ignored.
- [x] **§10 test 6 (env parity) automated here:** identical intent under equivalent dev/live grants → identical response shapes (same keys, same types), different data.
- [x] All prior tests green.

Covered in `mvp/apps/web/test/mcp-endpoint.integration.test.ts` (endpoint wiring, refusal paths) and `mvp/apps/web/test/mcp-endpoint-acceptance.integration.test.ts` (probe suite over both `query_collection` and `search_documents`, `search_documents` success path, env wall + forged-env-arg, env parity) — the latter uses `setupWebDbWithData` (`mvp/apps/web/test/helpers/web-db.ts`) to apply the meridian YAML, generate synthetic data, seed live data, and index `policies` for both envs, since the base test harness only provisions empty `data_synth`/`data_live` schemas.

## Expansion notes

- Pin the MCP SDK version and transport (streamable HTTP) at expansion time; decide session handling (stateless per-request vs SDK session manager).
- The chat-route rewire must preserve the Phase 0 LLM fabrication guard (§10 test 12) — the guard's `queriedOk` scan needs to recognize the shared tool implementations' result shapes.
