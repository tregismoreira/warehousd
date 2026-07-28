# Connect Claude to warehousd

Add warehousd as an MCP connector in Claude and confirm the whole chain works:
the OAuth flow lands on your IdP's login page, tools work from the conversation,
and a probe for a field you have no grant for fails cleanly.

Configure SSO first — see [configure-sso.md](./configure-sso.md). Without a
provider registered, the flow works the same way but authenticates against
warehousd's own login form.

This is a manual walkthrough: it drives a real Claude connector session, so it is
not part of the automated suite.

---

## 0. Prerequisites

- warehousd running with at least one SSO provider registered (`configure-sso.md`).
- `WAREHOUSD_DEMO=true` is fine to leave on; it only affects the local-login form.
- The app's `mcpUrl` — `http://localhost:8722/mcp` locally, or the public HTTPS
  URL of your deployment.

## 1. Add the connector in Claude

In Claude's connector settings, add a new MCP connector pointing at `mcpUrl`.

## 2. Trigger the OAuth flow

Start a conversation and invoke a tool (or use Claude's "connect" prompt).
Claude opens the OAuth authorize flow.

**Expected:** the browser lands on your **IdP's** login page (Keycloak, Okta,
etc.) — not a warehousd-branded login form. `/mcp/authorize` redirects any
unauthenticated request straight to `/login`, and with an SSO provider
configured, `/login` defaults to the SSO button, so the round trip through
warehousd is invisible to the user.

## 3. Authenticate and consent

Log in with an IdP-managed account. If this is that user's first SSO login,
warehousd JIT-provisions them as `member` — see [configure-sso.md](./configure-sso.md).

If the signed-in user is eligible for both `env:dev` and `env:live` scopes
(has an approved live grant, and the client's policy allows both), you'll see
an env picker (`/oauth/env-picker`) before the flow completes — choose an
environment to proceed.

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

---

## Re-running this

- Re-run whenever the SSO provider, MCP authorize flow, or env-scope rules
  change materially — it's the one check that exercises the full chain
  (IdP → warehousd → Claude) as a real user would experience it.
- If step 2 lands on warehousd's own login form instead of the IdP's, check
  that an SSO provider is actually registered and `WAREHOUSD_DISABLE_LOCAL_LOGIN`
  isn't masking a misconfiguration — see [configure-sso.md](./configure-sso.md).
