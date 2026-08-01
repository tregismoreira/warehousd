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

### Sanity-check discovery before you start

Claude's connector finds the authorization server by calling `mcpUrl`
unauthenticated, reading the `WWW-Authenticate` header, and fetching the metadata
URL it names (RFC 9728). If that chain is broken the connector fails with an
unhelpful error, so confirm both hops answer first:

```bash
curl -i -X POST http://localhost:8722/mcp | grep -i www-authenticate
# → WWW-Authenticate: Bearer resource_metadata="http://localhost:8722/.well-known/oauth-protected-resource"

curl -s http://localhost:8722/.well-known/oauth-protected-resource | jq .
# → { "resource": …, "authorization_servers": [ … ], "scopes_supported": [ … ] }
```

Both are covered by `apps/web/test/mcp-endpoint.integration.test.ts`, so a failure
here means the instance is misconfigured (most likely `BETTER_AUTH_URL`, which is
what the header's origin is derived from — never the `Host` header) rather than a
code regression.

## Connecting to a local instance

`http://localhost:8722/mcp` is reachable from two kinds of client, and only one
of them can actually see your machine.

### Claude Code, on the same machine — no tunnel

```bash
claude mcp add --transport http warehousd http://localhost:8722/mcp
```

Claude Code runs locally, so it connects to your loopback address directly and
the OAuth flow opens in your own browser. Nothing needs to be exposed. Use
`claude mcp list` to confirm it registered, and `/mcp` inside a session to check
the connection and re-run authorization if it lapsed.

### claude.ai and the desktop app — a tunnel, and one variable

Those clients connect from Anthropic's infrastructure, which cannot route to your
`localhost`. Publish the port with a tunnel and give Claude the tunnel URL:

```bash
cloudflared tunnel --url http://localhost:8722    # or: ngrok http 8722
```

**Set `BETTER_AUTH_URL` to the tunnel URL and restart warehousd.** This is the
load-bearing step and the one that is easy to miss, because the connector fails
with an unhelpful error rather than a wrong-origin one:

```bash
BETTER_AUTH_URL=https://your-tunnel.example.com warehousd start
```

Both halves of the discovery chain derive their origin from that variable and
never from the `Host` header — the `WWW-Authenticate` header
(`app/mcp/route.ts`) and the OAuth issuer in the discovery documents alike. That
is deliberate: a connector URL derived from an attacker-controlled header would
send a user's OAuth flow somewhere else. The consequence is that a tunnel whose
URL warehousd has not been told about advertises `http://localhost:8722` to a
client that cannot reach it, and the flow stalls with nothing useful in the log.

Verify before adding the connector, from anywhere:

```bash
curl -s https://your-tunnel.example.com/.well-known/oauth-protected-resource | jq .
# → "resource" and "authorization_servers" must both name the tunnel URL,
#   not localhost.
```

A tunnel URL that changes on every restart — ngrok's free tier does — has to be
put back into `BETTER_AUTH_URL` and the connector re-added each time. A named
tunnel is worth the setup if you do this more than once.

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
