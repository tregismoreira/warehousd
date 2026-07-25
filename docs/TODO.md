# TODO — human-only work

Tasks surfaced while executing `docs/superpowers/plans/2026-07-25-phase-5-web-ui.md` that cannot be completed by an agent (require external accounts/credentials, physical screenshots, or human judgment calls).

## Carried over from Phase 4 (SSO)

- [ ] **§10 test 11 (manual e2e, screenshots)** — `docs/connect-claude.md` and `docs/configure-sso.md` are written but marked "NOT YET EXECUTED — outstanding human work". A human needs to: configure a real IdP (Okta/Entra ID/Google Workspace), walk through the Claude connector setup against a running warehousd instance, capture screenshots, and confirm the denied-field probe fails cleanly. Requires real IdP credentials that an agent cannot provision.

## Phase 5 items expected to need human sign-off

- [ ] **Task 5 Step 7 (manual console smoke test)** — requires a real `ANTHROPIC_API_KEY` and a human at a browser: start the test stack, run `dev-bootstrap.ts`, run the web app with `WAREHOUSD_DEMO=true`, sign in as `mia@meridian.demo` / `demo`, land on `/member`, open **Chat console**, ask "what does the remote work policy say?" and confirm a streamed answer from `search_documents`; then confirm `/` redirects correctly for all three personas. Skipped by the implementer agent — no API key available in this environment.

(To be filled in further as Task 23 Playwright / Task 24 design review / Task 25 acceptance gate surface anything needing human judgment — e.g. visual design approval, production secrets for the import path, or manual browser confirmation beyond what Playwright can assert.)
