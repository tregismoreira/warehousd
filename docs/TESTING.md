# Manual Test Guide

Follow [SETUP.md](./SETUP.md) first. Start the app with `WAREHOUSD_DEMO=true` so the demo credential buttons appear.

---

## 1. Auth gate — unauthenticated redirect

1. Open **http://localhost:8722** in a fresh browser or incognito window.
2. **Expected:** immediately redirected to `/login`.
3. **Expected:** login page shows three demo credential buttons (Ana / Marcus / Mia).

---

## 2. Login as a member (Mia)

1. Click the **Mia** demo button or enter `mia@demo.local` / `demo`.
2. **Expected:** redirected to `/` (console).
3. **Expected:** header shows `mia@demo.local (member)` — no persona dropdown anywhere.
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
2. Sign in as **Marcus** (`marcus@demo.local` / `demo`).
3. **Expected:** header shows `marcus@demo.local (manager)`.
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
2. Restart with `SANDBOXD_DISABLE_LOCAL_LOGIN=true`:
   ```bash
   SANDBOXD_DISABLE_LOCAL_LOGIN=true \
   WAREHOUSD_PROJECT_DIR=examples/meridian \
   pnpm --filter @warehousd/web dev
   ```
3. Visit **http://localhost:8722** (unauthenticated).
4. **Expected:** login page shows "Local login is disabled" notice and **no** email/password form and **no** demo buttons.

---

## 11. Automated tests

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

**Expected:** all tests pass (broker + web + CLI).
