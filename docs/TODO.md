# TODO — human-only work

Tasks surfaced while executing `docs/superpowers/plans/2026-07-25-phase-5-web-ui.md` that cannot be completed by an agent (require external accounts/credentials, physical screenshots, or human judgment calls).

## Carried over from Phase 4 (SSO)

- [ ] **§10 test 11 (manual e2e, screenshots)** — `docs/connect-claude.md` and `docs/configure-sso.md` are written but marked "NOT YET EXECUTED — outstanding human work". A human needs to: configure a real IdP (Okta/Entra ID/Google Workspace), walk through the Claude connector setup against a running warehousd instance, capture screenshots, and confirm the denied-field probe fails cleanly. Requires real IdP credentials that an agent cannot provision.

## Phase 5 items expected to need human sign-off

- [ ] **Task 5 Step 7 (manual console smoke test)** — requires a real `ANTHROPIC_API_KEY` and a human at a browser: start the test stack, run `dev-bootstrap.ts`, run the web app with `WAREHOUSD_DEMO=true`, sign in as `mia@demo.local` / `demo`, land on `/member`, open **Chat console**, ask "what does the remote work policy say?" and confirm a streamed answer from `search_documents`; then confirm `/` redirects correctly for all three personas. Skipped by the implementer agent — no API key available in this environment.

## Phase 5 wrap-up

- [x] **Push `phase-5-web-ui` and open the PR to `main`** (plan Task 25, Step 7) — done; merged as PR #6 (`a32f2ce`).

Task 23 (Playwright) and Task 24 (design review) did not surface anything requiring human-only judgment beyond the above — both were completed end-to-end by the agent, including real-browser screenshots of all eleven surfaces via the Playwright MCP tools, and several real bugs found and fixed along the way (see the `polish(web): design review pass` commit).

## Deferred hardening (reviewed, not blocking Phase 5)

- [x] **Mark the `wh_env` cookie `Secure`** — done in `f11fb7b`. `app/api/env/route.ts` now adds `Secure` when the request arrives over HTTPS and omits it on plain-HTTP localhost, so the dev/demo setup keeps working.
- [x] **`deepMerge` in `config/load.ts` assigns `__proto__` as a computed key** — done in `f11fb7b`. The accumulator is now `Object.create(null)`, so a `__proto__` key in `warehousd.local.yml` lands as an ordinary property instead of reaching the prototype chain.

---

# Phase 6 (CLI lifecycle + distribution) follow-ups

## 1. Close the two-tier grant/deny posture gap

**Status: half closed.** `requestGrant`'s side is done — `validateGrantRequest`
(`packages/broker/src/grants/manage.ts`) now enforces
`allowedFields ⊆ grantableFields(cfg, collection)`, and both callers that reach
`app.grants` go through it: the web route (`app/api/grants/route.ts`) and the MCP
`request_access` tool (`lib/mcp-tools.ts`). **`approveGrant` is still unvalidated**
— the remaining work below is that half only.

**What:** `approveGrant` (broker package) still accepts any `allowedFields` the
caller supplies. There's no validation that
`allowedFields ⊆ grantableFields(cfg, collection)`, so an approval could in
principle include fields the config marks `posture: deny`. (The web approve path
is safe today because `buildApproval` in `apps/web/lib/approve.ts` derives the
field set from YAML rather than the request body — but that is a caller-side
guarantee, not one the broker enforces.)

**Why it matters:** During Task 12 we confirmed `v_<collection>` views are
*intentionally* flat (every field present regardless of posture) — access
control is meant to be enforced entirely at the grant/query layer, not by
omitting columns from the view. That design only holds if grants are
actually validated against `grantableFields()`. Right now they aren't, so
the two-tier deny model is not fully real yet.

**Scope:** A broker-package behavior change (`approveGrant`/`requestGrant`
plus their own tests). Does not touch the CLI, Docker, or view DDL.

**Source:** explicit note in the human decision that resolved the Task 12
plan-vs-codebase conflict — see
`.superpowers/sdd/phase-6-cli-plan/task-12-brief.md` and the ledger entry
for Task 12 in `.superpowers/sdd/phase-6-cli-plan/progress.md`.

## 2. Minor, non-blocking items parked during the final whole-branch review

Neither of these is a correctness bug; both were judged acceptable to ship
as-is but are worth a deliberate decision later:

- **`warehousd stop --destroy`** requires an explicit `--yes` flag rather
  than falling back to an interactive y/N prompt when omitted
  (`packages/cli/src/stop.ts`). Fine for scripts/CI; slightly unfriendly
  for interactive use.
- **`as any` type casts** in `apps/web/lib/auth.ts`, `lib/oauth.ts`,
  `lib/broker-context.ts`, `lib/session.ts` — worked around a loosely-typed
  Better Auth plugin API surface. **Investigated and deliberately kept for
  `lib/oauth.ts`:** the context type `createAuthMiddleware` infers for its
  callback does not describe the fields the three `envScopePlugin` hooks read at
  runtime, so removing the annotations does not type-check — it produces
  "ctx.query is possibly undefined" and "Property 'scopes' does not exist on
  type '{}'" against `ctx.query` / `ctx.body` / `ctx.context.returned` /
  `ctx.context.adapter`. Verified by removing them and running `tsc`. The
  rationale now lives in a comment above the plugin. Revisit if Better Auth ever
  exports a per-endpoint context type.
