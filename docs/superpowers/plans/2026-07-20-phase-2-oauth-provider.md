# Phase 2 — OAuth 2.1 Provider + Env-as-Scope (Execution Outline)

> **Status: outline.** Expand with superpowers:writing-plans before executing. Spec: `docs/SPECS.md` §6.1, §6.4–6.6. Roadmap: Phase 2. **This is the security-critical phase of the MVP.**

**Goal:** warehousd becomes an OAuth 2.1 authorization server (Better Auth OIDC-provider/MCP plugin) with env selection expressed purely as standard scopes (`env:dev` / `env:live`), enforced server-side at issuance per §6.1 rules 1–4.

**Depends on:** Phase 1 (sessions, roles).

## Tasks

- [ ] Better Auth OIDC-provider/MCP plugin: authorization server with 15-min access tokens + refresh tokens
- [ ] `app.client_policies` table exactly per §6.1 (`client_id pk`, `display_name`, `allowed_scopes text[] not null default '{env:dev}'`, `promoted_at`, `promoted_by`)
- [ ] Scope-issuance hook implementing §6.1 rules:
  1. requested scopes ∩ `client_policies.allowed_scopes` (escalation impossible by construction)
  2. `env:live` additionally requires the user to hold ≥1 grant `status='approved' and env='live' and expires_at > now()`
  3. both survive → consent-screen env picker (radio, default `dev`); exactly one env scope per token, never both
  4. rules re-run on every refresh (revoked promotion / expired grant takes effect within one refresh cycle)
- [ ] Dynamic client registration (RFC 7591): dynamic clients get `allowed_scopes = {env:dev, env:live}`; manually created clients get `{env:dev}` always, no creation-time override
- [ ] Token-verification adapter `mvp/apps/web/lib/broker-context.ts` — the **sole** constructor of `BrokerContext` for token paths (§6.1 snippet verbatim); missing env scope → `dev`; tokens carry only sub/client/env — no grant data
- [ ] Promotion/demotion primitives: data layer + minimal API (set/unset `env:live` in `allowed_scopes`, stamp `promoted_at/by`); admin UI lands in Phase 5

**Key files:** `mvp/apps/web/lib/oauth.ts` (provider config + scope hook), `mvp/apps/web/lib/broker-context.ts`, `mvp/packages/broker/src/db/app-schema.ts` + `migrate-app.ts` (+`client_policies`).

## Acceptance gate — completes §10 test 5

- Dev-only client requesting `scope=env:live` → issued token contains only `env:dev` (asserted on the token).
- After promotion, next refresh yields `env:live`; after demotion, next refresh drops it.
- User with no approved live grant never receives `env:live`, even from a live-allowed client.
- Token with no env scope → adapter resolves `dev`.
- Token payload contains only sub/client/env scope — no grant data.
- Revoked grant → `env:live` gone within one forced refresh.
- All prior tests green.

## Expansion notes

- Verify the current Better Auth plugin names/APIs at expansion time (OIDC provider vs MCP plugin split has been moving); pin versions in the detailed plan.
- Consent-screen env picker is custom UI on the authorize page — needs a task of its own with the §6.1 rule-3 logic server-side (the radio is a hint; the server enforces exactly-one).
- Decide where `client_policies` writes happen (Drizzle vs raw SQL) consistent with `createAppSchema` idempotency.
