# Phase 1 — Real Identity: Better Auth Core + Roles — Design Spec

**Status:** Draft for handoff · **Audience:** Claude (implementation planning) · **Author:** Thiago
**Scope:** Phase 1 of `docs/MVP-ROADMAP.md`. Realizes `docs/SPECS.md` §6.2–6.3 and §3 (Role) in `mvp/apps/web`. The broker (`mvp/packages/broker`) is untouched — this is authentication + web-console wiring only.

> **For implementation:** This is a *design spec*, not the task list. The task-by-task TDD plan lives at `docs/superpowers/plans/2026-07-20-phase-1-real-identity.md` (built with the `writing-plans` skill).

---

## 1. Goal

Replace the POC persona switcher with real session authentication (Better Auth email/password), a three-tier role model, and role-checked grant APIs. The web console stops trusting the client to say "who am I" and "which env" — both now come from a verified session server-side.

## 2. Non-goals (this increment)

- **No SSO / OIDC provider yet.** `docs/SPECS.md` §6 mandates generic OIDC SSO and warehousd-as-OAuth-provider, but that is Phase 2. Local email/password credentials — the §6.2 bootstrap/demo fallback — are the only login mechanism in Phase 1.
- **No OAuth token scopes.** The `env:dev`/`env:live` scope machinery (§6.1), `client_policies`, and MCP OAuth are Phase 2. Here, env is a **web-console-only** session value.
- **No JIT provisioning, no IdP group→role mapping.** Roles are seeded and (future) admin-promoted; there is no admin role-management UI in this increment.
- **Broker package changes.** None. All invariants in `docs/SPECS.md` §4 hold unchanged.

## 3. Roles

A `role` field is added to the user, exactly one of `admin | manager | member` (lowercase). Semantics for this phase:

- **member** — any authenticated user. May *request* grants and query under their own approved grants.
- **manager** / **admin** — may additionally *approve*, *deny*, and *revoke* grants.

Roles are stored on Better Auth's `user` table as an additional field (default `member`), seeded for the three demo personas (§6).

## 4. The core invariant: identity and env are server-derived

This is the security heart of the phase, and it is the §6.1 `BrokerContext` rule applied to the web console:

> `BrokerContext` is constructed in exactly one place. `userId` comes from the verified session; `env` comes from a session-scoped, server-set value. **No `userId`/`persona`/`env` value in a request body or query string is ever read.**

Concretely:
- `userId` ← verified Better Auth session (`session.user.id`).
- `env` ← a signed, http-only `wh_env` cookie, changed only via a dedicated `POST /api/env` route (which itself requires a session). Never a request parameter to chat, grants, or the broker.

The acceptance gate proves this: a `userId`/`env` planted in a request is provably ignored — the session wins.

## 5. Surface changes

- **Auth backend.** Better Auth owns `user`/`session`/`account`/`verification` tables in the existing `app` Postgres schema, created idempotently alongside the hand-written `createAppSchema` tables. They own disjoint table names, so create-if-not-exists on both sides never clobbers. `SANDBOXD_DISABLE_LOCAL_LOGIN=true` fully disables email/password login.
- **Login screen.** Email/password form. In demo mode (`WAREHOUSD_DEMO=true`) it lists the §9 persona credentials; when local login is disabled it shows an SSO-only notice instead of a form.
- **Console page.** Persona dropdown deleted. Unauthenticated visits redirect to `/login`. The env toggle POSTs to `/api/env` (server-side cookie), never a client-held param. Header shows the logged-in user, role, and sign-out.
- **Grants API.** `request` is allowed for any authenticated user; `approve`/`deny`/`revoke` require `manager`/`admin` (else 403). The acting user (`decided_by`) is the session user, not a body value.
- **Middleware.** Unauthenticated requests to `/api/chat`, `/api/grants` (incl. `/api/grants/doc-paths`), `/api/audit`, `/api/env` → 401.
- **Seed.** `dev-bootstrap.ts` upgrades Ana/Marcus/Mia into real local-credential users with fixed ids (`ana`/`marcus`/`mia`, so pre-seeded `app.grants` rows still match) and §9 roles. Their existing seeded grants (including Mia's pending `salaries` request in Marcus's inbox) are unchanged.

## 6. Demo personas (from `docs/SPECS.md` §9)

Local credentials, password `demo`, shown on the login screen in demo mode:

| Persona | Email | Role | Demo purpose |
|---|---|---|---|
| Ana | `ana@meridian.demo` | admin | IT view: postures, audit, SSO config |
| Marcus | `marcus@meridian.demo` | manager | Has Mia's pending `salaries` request in his inbox |
| Mia | `mia@meridian.demo` | member | Approved dev grants for `documents`+`people`; pending `salaries` request |

## 7. Acceptance gate (definition of done)

1. All Phase 0/0.5 tests stay green (broker untouched).
2. New integration tests: **401** on unauthenticated chat/grants/audit routes; **403** on member-attempted approve; session-derived `BrokerContext.userId` matches the logged-in user, and a planted `userId`/`env` in the request is provably ignored.
3. Demo login as each persona works; Mia's pending `salaries` arc (probe fails → manager grants → revoke cuts it live) still demos end-to-end in chat.

## 8. Resolved design questions

- **Better Auth schema vs. `createAppSchema`.** Coexist by construction — disjoint table names in the `app` schema, both create-if-not-exists. The implementation empirically confirms the migration path (programmatic runner vs `@better-auth/cli migrate`) against the installed version before relying on it, rather than assuming an API.
- **Env is a session value, never a param.** Enforced via the `wh_env` cookie + `/api/env` route — the same rule tokens will enforce in Phase 2, so the console's mental model already matches the eventual OAuth flow.
