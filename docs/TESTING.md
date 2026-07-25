# Manual Test Guide

Follow [SETUP.md](./SETUP.md) first. Start the app with `WAREHOUSD_DEMO=true` so the demo credential buttons appear.

---

## 1. Auth gate — unauthenticated redirect

1. Open **http://localhost:8722** in a fresh browser or incognito window.
2. **Expected:** immediately redirected to `/login`.
3. **Expected:** login page shows three demo credential buttons (Ana / Marcus / Mia).

---

## 2. Login as a member (Mia)

1. Click the **Mia** demo button or enter `mia@meridian.demo` / `demo`.
2. **Expected:** redirected to `/` (console).
3. **Expected:** header shows `mia@meridian.demo (member)` — no persona dropdown anywhere.
4. **Expected:** Grants panel shows Mia's grants. The approve/deny/revoke buttons are absent (members cannot approve).

---

## 3. Chat — session-derived context

While signed in as Mia:

1. Type a query that touches an approved collection, e.g. "who are the people in the HR department?"
2. **Expected:** a response is returned (Mia has an approved `people` grant in dev env).
3. Type a query that touches `salaries`, e.g. "what is the average base salary?"
4. **Expected:** broker refuses — Mia's `salaries` grant is in `pending` status.

---

## 4. Grant approval flow (Marcus → Mia)

1. Sign out (button in the header).
2. Sign in as **Marcus** (`marcus@meridian.demo` / `demo`).
3. **Expected:** header shows `marcus@meridian.demo (manager)`.
4. **Expected:** Grants panel shows a pending `salaries` request from Mia with an **Approve** button.
5. Click **Approve**.
6. **Expected:** the grant status changes to approved.

---

## 5. Verify approved grant works

1. Sign out, sign back in as **Mia**.
2. Ask the chat: "what is the average base salary for senior accountants?"
3. **Expected:** the broker returns salary data (grant is now approved).

---

## 6. Revoke and confirm denial

1. Sign out, sign in as **Marcus**.
2. Find Mia's `salaries` grant and click **Revoke**.
3. Sign out, sign in as Mia.
4. Ask the same salary question again.
5. **Expected:** broker refuses — grant is now revoked.

---

## 7. Member cannot approve (role check)

While signed in as Mia:

1. Open DevTools → Network tab.
2. Run this in the browser console:
   ```js
   fetch('/api/grants', {
     method: 'POST',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({ action: 'approve', id: '00000000-0000-0000-0000-000000000000' })
   }).then(r => console.log(r.status))
   ```
3. **Expected:** `403`.

---

## 8. Planted userId/env in body is ignored

While signed in as Mia:

1. In the browser console:
   ```js
   fetch('/api/grants?user=marcus').then(r => r.json()).then(d => console.log(d.mine))
   ```
2. **Expected:** returned grants all have `user_id === "mia"` — the `?user=marcus` param is silently ignored.

---

## 9. Env toggle

While signed in as any user:

1. Toggle the **dev / live** switch on the console.
2. **Expected:** the toggle updates without a full page reload; subsequent chat queries use the new env.
3. Reload the page.
4. **Expected:** the toggle is still on the env you selected (persisted as a cookie).

---

## 10. Local login kill-switch

1. Stop the dev server.
2. Restart with `WAREHOUSD_DISABLE_LOCAL_LOGIN=true`:
   ```bash
   WAREHOUSD_DISABLE_LOCAL_LOGIN=true \
   WAREHOUSD_PROJECT_DIR=examples/meridian \
   pnpm --filter @warehousd/web dev
   ```
3. Visit **http://localhost:8722** (unauthenticated).
4. **Expected:** login page shows "No login method is configured" (no SSO providers registered in this dev setup).

---

## 11. SSO — configure an IdP (admin-only)

> **Not yet run.** Full runbook with context: [configure-sso.md](./configure-sso.md).

1. Start a local Keycloak (realm `warehousd-test` is pre-imported, with both an
   OIDC and a SAML client):
   ```bash
   cd mvp
   docker compose -f docker-compose.test.yml up -d keycloak
   ```
2. Restart the dev server with the IdP origin trusted — **without this,
   registration fails with `discovery_private_host`**, because Better Auth
   rejects loopback/private issuers by default:
   ```bash
   WAREHOUSD_TRUSTED_ORIGINS=http://127.0.0.1:8780 \
   WAREHOUSD_DEMO=true \
   WAREHOUSD_PROJECT_DIR=examples/meridian \
   pnpm --filter @warehousd/web dev
   ```
3. Sign in as **Mia** (member). In the browser console:
   ```js
   fetch('/api/sso/providers', {
     method: 'POST',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({ providerId: 'x', issuer: 'http://127.0.0.1:8780', domain: 'meridian.demo' })
   }).then(r => console.log(r.status))
   ```
   **Expected:** `403`. Repeat as **Marcus** (manager) → also `403`.
4. Sign out, sign in as **Ana** (admin). In the console:
   ```js
   fetch('/api/sso/providers', {
     method: 'POST',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({
       providerId: 'keycloak-oidc',
       issuer: 'http://127.0.0.1:8780/realms/warehousd-test',
       domain: 'meridian.demo',
       oidcConfig: {
         clientId: 'warehousd-oidc',
         clientSecret: 'oidc-secret',
         discoveryEndpoint: 'http://127.0.0.1:8780/realms/warehousd-test/.well-known/openid-configuration'
       }
     })
   }).then(r => console.log(r.status))
   ```
   **Expected:** 2xx.
5. **Expected:** `fetch('/api/sso/status').then(r=>r.json()).then(console.log)` lists
   the provider and contains **no** `clientSecret` anywhere in the response.

---

## 12. SSO-first login page — all four states

> **Highest-value manual test in this file.** `apps/web/app/login/page.tsx` has
> **no automated test coverage** — no component or browser test exercises any of
> the states below. Eyeballing them is currently the only verification that this
> code works. See the coverage note in [MVP-ROADMAP.md](./MVP-ROADMAP.md) Phase 4.

With the provider from §11 registered, visit `/login` unauthenticated each time:

| # | Setup | Expected |
|---|---|---|
| a | No provider registered, local login on | Plain email/password form + demo buttons (unchanged from §1) |
| b | Provider registered, local login on | **"Sign in with your company account"** as the primary button; the email/password form collapsed under a **"Use a local account"** disclosure |
| c | Provider registered, `WAREHOUSD_DISABLE_LOCAL_LOGIN=true` | SSO button only — no form, no demo buttons |
| d | No provider, `WAREHOUSD_DISABLE_LOCAL_LOGIN=true` | **"No login method is configured"** (this is §10) |

Then check the OAuth-continuation redirect:

6. Visit `/login?client_id=abc&response_type=code&scope=openid` directly.
7. Sign in (either method).
8. **Expected:** you land on `/api/auth/mcp/authorize?...` carrying **every**
   original query param — not on `/`. Signing in from a plain `/login` with no
   OAuth params must still land on `/`.
9. If a SAML provider is also registered, confirm its button starts the SAML
   flow (the client sends `providerType: "saml"`), not the OIDC one.

---

## 13. MCP + SSO end-to-end — §10 acceptance test 11

> **Not yet run. This is the last item blocking Phase 4 sign-off.**
> Full runbook with the screenshot checklist: [connect-claude.md](./connect-claude.md).

1. With SSO configured (§11), add the connector in Claude pointing at
   `http://localhost:8722/mcp`.
2. Trigger the OAuth flow from a conversation.
3. **Expected — the headline check:** the browser lands on **Keycloak's** login
   page, *not* warehousd's own form. This is the §6 item 4 claim of the whole phase.
4. Log in with `sso-user@meridian.demo` / `demo`. If the user is eligible for both
   `env:dev` and `env:live`, an env picker appears first — pick one.
5. **Expected:** the JIT-provisioned user lands as `member` (check the header, or
   `select role from app."user" where email='sso-user@meridian.demo'`).
6. Run `list_collections` in the conversation. **Expected:** returns collection
   names + descriptions.
7. Ask for a field the user has no grant for (e.g. `email` on `people`).
   **Expected:** a clean `field_denied`-style refusal with the request-access
   hint. Confirm the denied value appears **nowhere** in the response, the error
   message, or the server logs — and that Claude's final message states access
   was denied rather than fabricating data.
8. Capture the 7 screenshots called for in the two runbooks, save under
   `docs/img/`, and delete the status banners at the top of each.

---

## 14. Automated tests

These cover the auth gate, role checks, and session-derived context programmatically:

```bash
cd mvp
pnpm test:up
WAREHOUSD_PROJECT_DIR=examples/meridian npx vitest run apps/web/test/auth.integration.test.ts
```

**Expected:** 5/5 passing.

Full suite:

```bash
WAREHOUSD_PROJECT_DIR=examples/meridian pnpm test
```

**Expected:** 36 files / 172 tests pass, 1 file / 3 tests skipped. The skipped
file is the Keycloak e2e suite — it is gated behind `WAREHOUSD_E2E_KEYCLOAK` so
the default run never needs a container beyond Postgres.

Gated Keycloak e2e (real IdP — OIDC login, SAML login, SP metadata):

```bash
pnpm test:up    # brings up Postgres AND Keycloak
pnpm test:e2e
```

**Expected:** 3/3 passing.

### Also run these before calling a change done

Neither is covered by `pnpm test` — vitest does not typecheck, so type errors
can (and did) sit undetected while every test passed:

```bash
pnpm build                              # production build + full typecheck
npx tsc --noEmit -p apps/web/tsconfig.json   # full error list; `next build` only reports the first
pnpm lint
```

**Expected:** all three clean.
