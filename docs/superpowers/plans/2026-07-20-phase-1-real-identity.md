# Phase 1 — Real Identity: Better Auth Core + Roles (Execution Outline)

> **Status: outline.** Before executing, expand into a full TDD task breakdown with the superpowers:writing-plans skill (as `2026-07-20-phase-0.5-document-indexing.md` was). Spec: `docs/SPECS.md` §6.2–6.3, §3 (Role). Roadmap: `docs/MVP-ROADMAP.md` Phase 1.

**Goal:** Replace the POC persona switcher with real session authentication (Better Auth), roles, and role-checked grant APIs — in `mvp/apps/web`.

**Depends on:** Phase 0.5 complete (mvp workspace exists with ported broker + web console). Broker itself is untouched this phase.

## Port-from-POC checklist

- Nothing new to port: `mvp/apps/web` was ported in Phase 0.5 Task 12. This phase **deletes** the `// POC-ONLY` persona code (`app/lib/persona.ts` and the persona dropdown in the UI).

## Tasks

- [ ] Install Better Auth in `mvp/apps/web`; configure with the `app`-schema Postgres (Better Auth-managed tables `user`, `session`, `account` in schema `app`, alongside Drizzle defs)
- [ ] Local email/password login (bootstrap fallback only per §6.2) + login screen; demo mode shows §9 persona credentials on the login screen
- [ ] `role` field on user: `admin` | `manager` | `member`; seed script upgrades Ana/Marcus/Priya into real local-credential users with §9 roles and their pre-seeded grants (dev-bootstrap change)
- [ ] `SANDBOXD_DISABLE_LOCAL_LOGIN=true` fully disables local credentials
- [ ] Delete the persona switcher; `BrokerContext` in every UI route derives from the verified session: `userId` from session, `env` from an authenticated console env toggle (web-console-only; token scopes replace it for API paths in Phase 2)
- [ ] Role checks on the grants API route: approve/deny/revoke require `manager` or `admin`; request is any authenticated user
- [ ] Middleware: unauthenticated requests to chat/grants/audit/doc-paths routes → 401

**Key files:** `mvp/apps/web/lib/auth.ts`, `mvp/apps/web/app/api/auth/[...all]/route.ts`, `mvp/apps/web/middleware.ts`, delete `mvp/apps/web/app/lib/persona.ts`, modify `mvp/apps/web/app/api/{chat,grants,audit}/route.ts`, `mvp/scripts/dev-bootstrap.ts`.

## Acceptance gate

- All Phase 0/0.5 tests still green (broker untouched).
- New integration tests: 401 on unauthenticated chat/grants/audit routes; 403 on member-approve; session-derived `BrokerContext.userId` matches the logged-in user — a `userId`/`env` value planted in the request body is provably ignored.
- Demo login as each persona works; Priya's pending `salaries` arc still demos end-to-end.

## Expansion notes (for the detailed plan)

- Decide Better Auth schema-generation flow (CLI `npx @better-auth/cli generate` vs manual Drizzle defs) against the existing `createAppSchema` create-if-not-exists approach — must not clobber existing `app` tables.
- The env toggle is a session-scoped server-side value (cookie or session field), never a request body param — same rule as tokens.
