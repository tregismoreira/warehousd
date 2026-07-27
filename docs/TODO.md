# TODO — human-only work

Tasks surfaced while executing `docs/superpowers/plans/2026-07-25-phase-5-web-ui.md` that cannot be completed by an agent (require external accounts/credentials, physical screenshots, or human judgment calls).

## Carried over from Phase 4 (SSO)

- [ ] **§10 test 11 (manual e2e, screenshots)** — `docs/connect-claude.md` and `docs/configure-sso.md` are written but marked "NOT YET EXECUTED — outstanding human work". A human needs to: configure a real IdP (Okta/Entra ID/Google Workspace), walk through the Claude connector setup against a running warehousd instance, capture screenshots, and confirm the denied-field probe fails cleanly. Requires real IdP credentials that an agent cannot provision.

## Phase 5 items expected to need human sign-off

- [ ] **Task 5 Step 7 (manual console smoke test)** — requires a real `ANTHROPIC_API_KEY` and a human at a browser: start the test stack, run `dev-bootstrap.ts`, run the web app with `WAREHOUSD_DEMO=true`, sign in as `mia@demo.local` / `demo`, land on `/member`, open **Chat console**, ask "what does the remote work policy say?" and confirm a streamed answer from `search_documents`; then confirm `/` redirects correctly for all three personas. Skipped by the implementer agent — no API key available in this environment.

## Phase 5 wrap-up

- [ ] **Push `phase-5-web-ui` and open the PR to `main`** (plan Task 25, Step 7). All 26 tasks are implemented, verified, and committed locally; the full acceptance gate is green (Vitest 350/350, ESLint clean, `tsc --noEmit` clean, `next build` succeeds, Playwright 8/8). Pushing and opening a PR is visible to others and was left for explicit human confirmation rather than done automatically.

Task 23 (Playwright) and Task 24 (design review) did not surface anything requiring human-only judgment beyond the above — both were completed end-to-end by the agent, including real-browser screenshots of all eleven surfaces via the Playwright MCP tools, and several real bugs found and fixed along the way (see the `polish(web): design review pass` commit).

## Deferred hardening (reviewed, not blocking Phase 5)

- [ ] **Mark the `wh_env` cookie `Secure`** — `app/api/env/route.ts` sets it `HttpOnly; SameSite=Lax` but not `Secure`, because the dev/demo setup is plain HTTP on localhost. Not a privilege path (flipping it to `live` without a live grant still refuses with `no_grant`), but it should be conditional on HTTPS before any real deployment.
- [ ] **`deepMerge` in `config/load.ts` assigns `__proto__` as a computed key** — reachable only through `warehousd.local.yml`, an operator-controlled file, so this is a trusted-input path today. Worth closing if config ever becomes untrusted.

---

# Phase 6 (CLI lifecycle + distribution) follow-ups

## 1. Close the two-tier grant/deny posture gap

**What:** `approveGrant`/`requestGrant` (broker package) currently accept
any `allowedFields` the caller supplies. There's no validation that
`allowedFields ⊆ grantableFields(cfg, collection)`, so a grant could in
principle include fields the config marks `posture: deny`.

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
  Better Auth plugin API surface. No known runtime impact, but hides real
  type errors if the Better Auth API shape changes underneath them.
