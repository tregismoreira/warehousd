# Phase 3 — MCP Endpoint (Execution Outline)

> **Status: outline.** Expand with superpowers:writing-plans before executing. Spec: `docs/SPECS.md` §7. Roadmap: Phase 3.

**Goal:** OAuth-protected `/mcp` streamable-HTTP endpoint exposing the five governed tools, with `BrokerContext` derived exclusively from the verified token.

**Depends on:** Phase 2 (tokens). Phase 0.5 (`searchDocuments`).

## Tasks

- [ ] `/mcp` streamable-HTTP endpoint (MCP TypeScript SDK) in `mvp/apps/web`, OAuth-protected; `BrokerContext` via `lib/broker-context.ts` (Phase 2) — no other construction path
- [ ] Tools (complete list): `list_collections`, `describe_collection(name)`, `query_collection(intent)`, `search_documents(collection, q)` (§5.6.3), `request_access(collection, purpose, fields?)`
- [ ] `request_access` creates a `pending` grant row (via `requestGrant`) and returns the request id
- [ ] Refusals from `describe_collection`/`query_collection`/`search_documents` include the `request_access` hint; tool descriptions state deny-by-default + purpose-bound governance plainly (the model reading them is the first consumer of the security posture)
- [ ] Shared tool module `mvp/apps/web/lib/mcp-tools.ts`: tool defs + handlers used by **both** the MCP endpoint and the chat console's tool loop (console becomes a local MCP test bench; chat route rewired onto the shared implementations)

**Key files:** `mvp/apps/web/app/mcp/route.ts` (or `app/api/mcp/route.ts`), `mvp/apps/web/lib/mcp-tools.ts`, modify `mvp/apps/web/app/api/chat/route.ts`.

## Acceptance gate

- MCP-over-HTTP integration tests with a dev token: `list_collections` returns names+descriptions only; `describe_collection` grant-filtered; probe-suite hostile intents through `query_collection` refused with reason codes and zero canary leakage; `search_documents` grant-filtered with `_rank`/`chunk_index`; `request_access` produces a pending grant visible to Marcus.
- Env wall over MCP: dev-token session never returns live canaries (structured + document) across all five tools; forged env values in tool args ignored.
- **§10 test 6 (env parity) automated here:** identical intent under equivalent dev/live grants → identical response shapes (same keys, same types), different data.
- All prior tests green.

## Expansion notes

- Pin the MCP SDK version and transport (streamable HTTP) at expansion time; decide session handling (stateless per-request vs SDK session manager).
- The chat-route rewire must preserve the Phase 0 LLM fabrication guard (§10 test 12) — the guard's `queriedOk` scan needs to recognize the shared tool implementations' result shapes.
