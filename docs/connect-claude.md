# Connect Claude to warehousd via MCP (manual runbook)

Covers `docs/SPECS.md` §10 acceptance test 11: **MCP + SSO end-to-end.** Run
this once, manually, after configuring SSO (see [configure-sso.md](./configure-sso.md))
— it is not part of the automated CI suite because it drives a real Claude
connector session.

**Definition of done for this runbook:** the OAuth flow that Claude's
connector triggers lands on the **IdP's** login page, not warehousd's own
form; after consent, `list_collections` works from the conversation; and a
probe for a `deny`-posture field fails cleanly with a request-access hint
rather than leaking data or crashing.

> ## ⚠️ Status: NOT YET EXECUTED — outstanding human work
>
> The prose below was written from the implemented code paths, but **nobody has
> run it end-to-end yet.** Phase 4 is not complete until someone does. This
> cannot be automated — it needs a browser, the Claude connector UI, and a
> human confirming what's on screen.
>
> - [ ] Run steps 1–5 below against a live warehousd + Keycloak (or real IdP).
> - [ ] Capture the 4 screenshots marked `*(Screenshot: …)*` in this file,
>       save them under `docs/img/`, and replace each placeholder with a
>       markdown image link.
> - [ ] Confirm step 2 genuinely lands on the **IdP's** login page — this is
>       the headline §6 item 4 claim and the single most important thing to
>       eyeball.
> - [ ] Confirm step 5's denied-field probe leaks nothing into the
>       conversation, the error message, or the app logs.
> - [ ] Delete this banner once all boxes are ticked.
>
> See also `docs/configure-sso.md`, which has its own 3 screenshots pending.

---

## 0. Prerequisites

- warehousd running with at least one SSO provider registered (`configure-sso.md`).
- `WAREHOUSD_DEMO=true` is fine to leave on; it only affects the local-login form.
- The app's `mcpUrl` — for local dev, `http://localhost:8722/mcp`; for a
  deployed instance, the HTTPS URL from `.warehousd/outputs.deploy.json`.

## 1. Add the connector in Claude

In Claude's connector settings, add a new MCP connector pointing at `mcpUrl`.

*(Screenshot: Claude → Settings → Connectors → Add custom connector)*

## 2. Trigger the OAuth flow

Start a conversation and invoke a tool (or use Claude's "connect" prompt).
Claude opens the OAuth authorize flow.

**Expected:** the browser lands on your **IdP's** login page (Keycloak, Okta,
etc.) — not a warehousd-branded login form. This is the headline behavior
this phase exists to prove: `/mcp/authorize` redirects any unauthenticated
request straight to `/login`, and with an SSO provider configured, `/login`
defaults to the SSO button, so the round trip through warehousd is invisible
to the user.

*(Screenshot: browser showing the IdP's own login page, not warehousd's)*

## 3. Authenticate and consent

Log in with an IdP-managed account. If this is that user's first SSO login,
warehousd JIT-provisions them as `member` (see `configure-sso.md` §4).

If the signed-in user is eligible for both `env:dev` and `env:live` scopes
(has an approved live grant, and the client's policy allows both), you'll see
an env picker (`/oauth/env-picker`) before the flow completes — choose an
environment to proceed.

*(Screenshot: env picker, if shown)*

## 4. Confirm tools work

Back in the Claude conversation, run:

```
list_collections
```

**Expected:** returns collection names + descriptions the signed-in user has
at least some visibility into (deny-by-default still applies — a fresh
member with zero grants sees names only, no data).

## 5. Denied-field probe

Ask Claude to query a field the signed-in user does **not** have a grant for
(e.g. a `people` query requesting `email` when the grant excludes it).

**Expected:** the tool call fails cleanly with a `field_denied`-style error
and a request-access hint — no data leaks into the response, and the failure
doesn't crash or hang the conversation. Confirm the final message Claude
shows the user states access is denied rather than fabricating an answer.

*(Screenshot: Claude conversation showing the clean denial + request-access hint)*

---

## Notes for re-running this runbook

- Re-run whenever the SSO provider, MCP authorize flow, or env-scope rules
  change materially — it's the one check that exercises the full chain
  (IdP → warehousd → Claude) as a real user would experience it.
- If step 2 lands on warehousd's own login form instead of the IdP's, check
  that an SSO provider is actually registered and `WAREHOUSD_DISABLE_LOCAL_LOGIN`
  isn't masking a misconfiguration — see `configure-sso.md`.
