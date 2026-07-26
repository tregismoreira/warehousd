# TODO — human-only work

Tasks surfaced while executing `docs/superpowers/plans/2026-07-25-phase-5-web-ui.md` that cannot be completed by an agent (require external accounts/credentials, physical screenshots, or human judgment calls).

## Carried over from Phase 4 (SSO)

- [ ] **§10 test 11 (manual e2e, screenshots)** — `docs/connect-claude.md` and `docs/configure-sso.md` are written but marked "NOT YET EXECUTED — outstanding human work". A human needs to: configure a real IdP (Okta/Entra ID/Google Workspace), walk through the Claude connector setup against a running warehousd instance, capture screenshots, and confirm the denied-field probe fails cleanly. Requires real IdP credentials that an agent cannot provision.

## Phase 5 items expected to need human sign-off

- [ ] **Task 5 Step 7 (manual console smoke test)** — requires a real `ANTHROPIC_API_KEY` and a human at a browser: start the test stack, run `dev-bootstrap.ts`, run the web app with `WAREHOUSD_DEMO=true`, sign in as `mia@meridian.demo` / `demo`, land on `/member`, open **Chat console**, ask "what does the remote work policy say?" and confirm a streamed answer from `search_documents`; then confirm `/` redirects correctly for all three personas. Skipped by the implementer agent — no API key available in this environment.

## Phase 5 wrap-up

- [ ] **Push `phase-5-web-ui` and open the PR to `main`** (plan Task 25, Step 7). All 26 tasks are implemented, verified, and committed locally (57 commits ahead of `main`); the full acceptance gate is green (Vitest 348/348, ESLint clean, `tsc --noEmit` clean, `next build` succeeds, Playwright 8/8). Pushing and opening a PR is visible to others and was left for explicit human confirmation rather than done automatically.

Task 23 (Playwright) and Task 24 (design review) did not surface anything requiring human-only judgment beyond the above — both were completed end-to-end by the agent, including real-browser screenshots of all eleven surfaces via the Playwright MCP tools, and several real bugs found and fixed along the way (see the `polish(web): design review pass` commit).
