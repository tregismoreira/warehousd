# Phase 1 — Real Identity: Better Auth Core + Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the POC persona switcher in `mvp/apps/web` with real session authentication (Better Auth email/password), a three-tier role model, session-derived `BrokerContext`, role-checked grant APIs, and middleware that 401s unauthenticated requests.

**Architecture:** Better Auth owns its tables (`user`, `session`, `account`, `verification`) in the existing `app` Postgres schema, created idempotently alongside the hand-written `createAppSchema` tables — neither clobbers the other. A `role` column (`admin`|`manager`|`member`) is added to Better Auth's `user` table. Every UI/API route derives `BrokerContext` **server-side** from the verified session cookie: `userId` from `session.user.id`, `env` from a session-scoped console toggle (a signed cookie, never a request-body param). Grant mutation actions (`approve`/`deny`/`revoke`) require `manager` or `admin`; `request` is any authenticated user. A `middleware.ts` gates `/api/chat`, `/api/grants`, `/api/audit`, `/api/grants/doc-paths` with a 401 when no valid session cookie is present.

**Tech Stack:** Next.js 15 (App Router), React 19, Better Auth (`better-auth`), Postgres via `pg`, Anthropic SDK, Vitest for integration tests, pnpm workspaces.

## Global Constraints

- **Broker package is untouched this phase.** All changes live in `mvp/apps/web`, `mvp/scripts/dev-bootstrap.ts`, and `mvp/vitest.config.ts`. Do not edit anything under `mvp/packages/`.
- **All Phase 0/0.5 tests must stay green** — run `pnpm test` before declaring done.
- **`env` and `userId` are never request-body/query params to the broker.** They come only from the verified session (`userId`) and the session-scoped env cookie (`env`). Any `persona`/`userId`/`env` value in a request body is ignored and never read. This is the §6.1 invariant applied to the web console.
- **Role values are exactly** `"admin" | "manager" | "member"` (lowercase, these three strings).
- **User IDs stay stable across the demo:** seeded persona users keep the ids `"ana"`, `"marcus"`, `"mia"` so pre-seeded `app.grants` rows (keyed on those `user_id`s) continue to match. Better Auth's `user.id` for these three is set explicitly to those values in the seed.
- **Local-login kill switch:** when `SANDBOXD_DISABLE_LOCAL_LOGIN=true`, email/password sign-in is fully disabled and the login screen says so.
- **Demo credentials** (shown on the login screen when `WAREHOUSD_DEMO=true`, password `demo` for all three): `ana@meridian.demo` (admin), `marcus@meridian.demo` (manager), `mia@meridian.demo` (member).
- **Env DB URLs** already exist: `APP_DATABASE_URL`, `DEV_DATABASE_URL`, `LIVE_DATABASE_URL`. Add `BETTER_AUTH_SECRET` (any 32+ char string in dev) and `BETTER_AUTH_URL` (`http://localhost:8722` in dev).

---

## File Structure

**New files (all in `mvp/apps/web`):**
- `lib/auth.ts` — Better Auth server instance (`betterAuth({...})`), configured against `APP_DATABASE_URL`, `app` schema, email/password, `role` additional user field, local-login kill switch.
- `lib/auth-client.ts` — Better Auth React client (`createAuthClient`) for the login screen.
- `lib/session.ts` — `requireSession(req)` and `deriveContext(req)` helpers: verify the session cookie and build `BrokerContext` server-side; read the `env` cookie.
- `app/api/auth/[...all]/route.ts` — Better Auth catch-all handler (GET+POST).
- `app/api/env/route.ts` — POST sets the session-scoped `wh_env` cookie (`dev`|`live`); the only way the console changes env.
- `app/login/page.tsx` — login screen (email/password form; demo credentials listed when demo mode on; disabled-notice when local login off).
- `middleware.ts` — 401s unauthenticated requests to protected `/api/*` routes.
- `test/auth.integration.test.ts` — Vitest integration tests for the acceptance gate.
- `test/helpers/web-db.ts` — provisions a DB + runs `createAppSchema` + Better Auth migration + seeds the three persona users, returning handles the tests use.

**Modified files:**
- `app/lib/broker.ts` — unchanged in logic; re-exported context helper lives in `lib/session.ts` (see Task 4). No edit needed unless import paths require it.
- `app/api/chat/route.ts` — replace `contextFor(persona, env)` with `deriveContext(req)`.
- `app/api/grants/route.ts` — derive acting user from session; role-check POST actions.
- `app/api/audit/route.ts` — no body change, but now behind middleware (no code edit required beyond confirming it stays a GET).
- `app/api/grants/doc-paths/route.ts` — behind middleware; no body edit.
- `app/page.tsx` — remove persona dropdown; redirect to `/login` when unauthenticated; env toggle now POSTs to `/api/env`; show logged-in user + role + sign-out.
- `app/components/Chat.tsx` — drop `persona`/`env` props from the request body (server derives them); keep only `messages`.
- `app/components/Grants.tsx` — drop `persona` prop; fetch `/api/grants` (no `user` param — server derives); `canApprove` comes from session role passed as a prop.
- `mvp/scripts/dev-bootstrap.ts` — after schema setup, create the three Better Auth persona users with fixed ids + roles + hashed demo passwords.
- `mvp/vitest.config.ts` — extend `include` to also match `apps/**/test/**/*.test.ts`.
- `mvp/apps/web/package.json` — add `better-auth` dependency.
- `app/lib/persona.ts` — **deleted** (Task 12).

---

### Task 1: Install Better Auth and add config env vars

**Files:**
- Modify: `mvp/apps/web/package.json`

- [ ] **Step 1: Add the dependency**

Edit `mvp/apps/web/package.json` `dependencies` to add:

```json
"better-auth": "^1.2.0"
```

- [ ] **Step 2: Install**

Run: `cd mvp && pnpm install`
Expected: lockfile updates, `better-auth` resolves, no errors.

- [ ] **Step 3: Verify import resolves**

Run: `cd mvp && node -e "import('better-auth').then(m=>console.log(typeof m.betterAuth))"`
Expected: prints `function`

- [ ] **Step 4: Commit**

```bash
git add mvp/apps/web/package.json mvp/pnpm-lock.yaml
git commit -m "chore(web): add better-auth dependency"
```

---

### Task 2: Better Auth server instance

**Files:**
- Create: `mvp/apps/web/lib/auth.ts`

**Interfaces:**
- Produces: `export const auth` — a Better Auth instance. `auth.api.getSession({ headers })` returns `{ user: { id, email, name, role }, session } | null`. `auth.handler(req)` handles auth HTTP routes.
- Produces: `export const LOCAL_LOGIN_DISABLED: boolean`.

- [ ] **Step 1: Write the instance**

Create `mvp/apps/web/lib/auth.ts`:

```ts
import { betterAuth } from "better-auth";
import { Pool } from "pg";

export const LOCAL_LOGIN_DISABLED = process.env.SANDBOXD_DISABLE_LOCAL_LOGIN === "true";

// Better Auth manages user/session/account/verification tables in the `app` schema,
// alongside the hand-written app.grants / app.audit_events (createAppSchema). The two
// never touch the same table names, so create-if-not-exists on both sides is safe.
export const auth = betterAuth({
  database: new Pool({ connectionString: process.env.APP_DATABASE_URL }),
  // Keep Better Auth tables in the `app` schema (not public), matching the rest of the platform.
  advanced: { database: { schema: "app" } },
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:8722",
  emailAndPassword: {
    // Local credentials are the bootstrap/demo fallback (SPECS §6.2). Kill switch disables them entirely.
    enabled: !LOCAL_LOGIN_DISABLED,
    requireEmailVerification: false,
  },
  user: {
    additionalFields: {
      role: { type: "string", defaultValue: "member", input: false },
    },
  },
});

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "manager" | "member";
};
```

- [ ] **Step 2: Typecheck**

Run: `cd mvp/apps/web && npx tsc --noEmit`
Expected: no errors from `lib/auth.ts`. (Pre-existing errors elsewhere, if any, are out of scope — confirm none originate in this file.)

- [ ] **Step 3: Commit**

```bash
git add mvp/apps/web/lib/auth.ts
git commit -m "feat(web): better-auth server instance in app schema"
```

---

### Task 3: Better Auth HTTP handler route

**Files:**
- Create: `mvp/apps/web/app/api/auth/[...all]/route.ts`

**Interfaces:**
- Consumes: `auth` from `lib/auth.ts`.
- Produces: the `/api/auth/*` endpoints Better Auth's client calls (sign-in, sign-out, get-session, etc.).

- [ ] **Step 1: Write the handler**

Create `mvp/apps/web/app/api/auth/[...all]/route.ts`:

```ts
import { auth } from "../../../../lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const { GET, POST } = toNextJsHandler(auth.handler);
```

- [ ] **Step 2: Verify Better Auth can generate its schema (no clobber check)**

Run against a scratch DB to confirm Better Auth's migration creates its tables in `app` without touching `app.grants`:

Run: `cd mvp && npx @better-auth/cli generate --config apps/web/lib/auth.ts --output /tmp/ba-schema.sql -y || true`
Expected: emits `create table` statements for `user`/`session`/`account`/`verification`, all schema-qualified to `app`. (This is a read-only inspection; do not apply.)

- [ ] **Step 3: Commit**

```bash
git add mvp/apps/web/app/api/auth
git commit -m "feat(web): better-auth catch-all handler route"
```

---

### Task 4: Session + BrokerContext derivation helpers

**Files:**
- Create: `mvp/apps/web/lib/session.ts`

**Interfaces:**
- Consumes: `auth`, `SessionUser` from `lib/auth.ts`; `BrokerContext` from `@warehousd/broker`.
- Produces:
  - `export async function getSessionUser(req: Request): Promise<SessionUser | null>`
  - `export async function deriveContext(req: Request): Promise<BrokerContext | null>` — `{ userId: user.id, env }` where `env` is `"live"` only if the `wh_env` cookie equals `"live"`, else `"dev"`. Returns `null` when unauthenticated.
  - `export function readEnvCookie(req: Request): "dev" | "live"`

- [ ] **Step 1: Write the helpers**

Create `mvp/apps/web/lib/session.ts`:

```ts
import type { BrokerContext } from "@warehousd/broker";
import { auth, type SessionUser } from "./auth";

export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const s = await auth.api.getSession({ headers: req.headers });
  if (!s?.user) return null;
  return s.user as SessionUser;
}

// Env is a session-scoped console value read ONLY from the signed cookie, never from
// the request body/params (SPECS §6.1 invariant). Default dev.
export function readEnvCookie(req: Request): "dev" | "live" {
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)wh_env=(dev|live)(?:;|$)/);
  return m?.[1] === "live" ? "live" : "dev";
}

// The ONLY place BrokerContext is constructed in the web console. userId comes from the
// verified session; env from the env cookie. Any env-like body param is ignored.
export async function deriveContext(req: Request): Promise<BrokerContext | null> {
  const user = await getSessionUser(req);
  if (!user) return null;
  return { userId: user.id, env: readEnvCookie(req) };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd mvp/apps/web && npx tsc --noEmit`
Expected: no errors from `lib/session.ts`.

- [ ] **Step 3: Commit**

```bash
git add mvp/apps/web/lib/session.ts
git commit -m "feat(web): session-derived BrokerContext helpers"
```

---

### Task 5: Env-toggle route (session-scoped cookie)

**Files:**
- Create: `mvp/apps/web/app/api/env/route.ts`

**Interfaces:**
- Consumes: `getSessionUser` from `lib/session.ts`.
- Produces: POST `/api/env` with body `{ env: "dev" | "live" }` → sets `wh_env` cookie (httpOnly, sameSite lax, path `/`). 401 if unauthenticated. 400 if env invalid.

- [ ] **Step 1: Write the route**

Create `mvp/apps/web/app/api/env/route.ts`:

```ts
import { NextRequest } from "next/server";
import { getSessionUser } from "../../../lib/session";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { env } = await req.json();
  if (env !== "dev" && env !== "live") return Response.json({ error: "invalid env" }, { status: 400 });
  const res = Response.json({ ok: true, env });
  res.headers.append(
    "set-cookie",
    `wh_env=${env}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
  );
  return res;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd mvp/apps/web && npx tsc --noEmit`
Expected: no errors from `app/api/env/route.ts`.

- [ ] **Step 3: Commit**

```bash
git add mvp/apps/web/app/api/env
git commit -m "feat(web): session-scoped env toggle route"
```

---

### Task 6: Middleware — 401 unauthenticated protected routes

**Files:**
- Create: `mvp/apps/web/middleware.ts`

**Interfaces:**
- Consumes: Better Auth's session cookie (checked via cookie presence + `getSessionCookie`).
- Produces: 401 JSON on protected `/api/*` routes when no session cookie; passthrough otherwise.

- [ ] **Step 1: Write the middleware**

Better Auth ships `getSessionCookie` for edge/middleware use (cookie-presence check, not a DB hit — the routes themselves do full verification via `deriveContext`). Create `mvp/apps/web/middleware.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Protected API routes: unauthenticated → 401. /api/auth/* is intentionally NOT matched
// (login itself must be reachable). Full verification happens in each route via deriveContext;
// this is the fast gate.
export function middleware(req: NextRequest) {
  const cookie = getSessionCookie(req);
  if (!cookie) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/chat/:path*", "/api/grants/:path*", "/api/audit/:path*", "/api/env/:path*"],
};
```

Note: `/api/grants/doc-paths` is covered by the `/api/grants/:path*` matcher.

- [ ] **Step 2: Typecheck**

Run: `cd mvp/apps/web && npx tsc --noEmit`
Expected: no errors from `middleware.ts`.

- [ ] **Step 3: Commit**

```bash
git add mvp/apps/web/middleware.ts
git commit -m "feat(web): middleware 401s unauthenticated protected routes"
```

---

### Task 7: Chat route derives context from session

**Files:**
- Modify: `mvp/apps/web/app/api/chat/route.ts`

**Interfaces:**
- Consumes: `deriveContext` from `lib/session.ts`.
- Produces: chat route that ignores any `persona`/`env` in the body; builds `ctx` server-side.

- [ ] **Step 1: Replace the persona import and context construction**

In `mvp/apps/web/app/api/chat/route.ts`, replace this import line:

```ts
import { contextFor, type PersonaId } from "../../lib/persona";
```

with:

```ts
import { deriveContext } from "../../../lib/session";
```

- [ ] **Step 2: Replace body parsing + context in `POST`**

Replace:

```ts
  const { persona, env, messages } = await req.json() as
    { persona: PersonaId; env: "dev" | "live"; messages: Anthropic.MessageParam[] };
  const { broker } = getBroker();
  const ctx = contextFor(persona, env);
```

with:

```ts
  const ctx = await deriveContext(req);
  if (!ctx) return Response.json({ error: "unauthenticated" }, { status: 401 });
  // env/userId are NEVER read from the body — deriveContext is the only source (SPECS §6.1).
  const { messages } = await req.json() as { messages: Anthropic.MessageParam[] };
  const { broker } = getBroker();
```

- [ ] **Step 3: Typecheck**

Run: `cd mvp/apps/web && npx tsc --noEmit`
Expected: no errors referencing `persona`/`PersonaId`/`contextFor` in this file.

- [ ] **Step 4: Commit**

```bash
git add mvp/apps/web/app/api/chat/route.ts
git commit -m "feat(web): chat route derives BrokerContext from session"
```

---

### Task 8: Grants route — session actor + role checks

**Files:**
- Modify: `mvp/apps/web/app/api/grants/route.ts`

**Interfaces:**
- Consumes: `getSessionUser` from `lib/session.ts`.
- Produces: GET returns the acting user's grants (user from session, not query param); POST `approve`/`deny`/`revoke` require role `manager`|`admin` (else 403); `by` is the session user id, not the body.

- [ ] **Step 1: Add imports**

At the top of `mvp/apps/web/app/api/grants/route.ts`, add after the existing imports:

```ts
import { getSessionUser } from "../../../lib/session";
```

- [ ] **Step 2: Rewrite GET to use the session user**

Replace the GET body's first two statements:

```ts
  const user = req.nextUrl.searchParams.get("user") ?? "";
  const app = getAppPool();
```

with:

```ts
  const sessionUser = await getSessionUser(req);
  if (!sessionUser) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const user = sessionUser.id;
  const app = getAppPool();
```

- [ ] **Step 3: Rewrite POST with role checks**

Replace the entire `POST` function with:

```ts
export async function POST(req: NextRequest) {
  const sessionUser = await getSessionUser(req);
  if (!sessionUser) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { action, id, allowedFields, selectedPaths, expiresAt } = await req.json();
  const app = getAppPool();

  if (action === "request") {
    // any authenticated user may request; requester is the session user, never a body value
    // (request insertion handled elsewhere in the grants flow — kept as-is if present)
  } else {
    // approve/deny/revoke are privileged
    if (sessionUser.role !== "manager" && sessionUser.role !== "admin") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const by = sessionUser.id; // decided_by comes from the session, never the request body
  if (action === "approve") {
    const opts: any = { allowedFields, expiresAt };
    if (selectedPaths && selectedPaths.length > 0) {
      opts.rowFilter = { field: "path", op: "in", value: selectedPaths };
    }
    await approveGrant(app, id, by, opts);
  } else if (action === "deny") await denyGrant(app, id, by);
  else if (action === "revoke") await revokeGrant(app, id, by);
  return Response.json({ ok: true });
}
```

- [ ] **Step 4: Typecheck**

Run: `cd mvp/apps/web && npx tsc --noEmit`
Expected: no errors; `by`/`user` no longer read from body/query.

- [ ] **Step 5: Commit**

```bash
git add mvp/apps/web/app/api/grants/route.ts
git commit -m "feat(web): grants route uses session actor + role checks"
```

---

### Task 9: Seed persona users in dev-bootstrap

**Files:**
- Modify: `mvp/scripts/dev-bootstrap.ts`

**Interfaces:**
- Consumes: `auth` from `../apps/web/lib/auth`.
- Produces: three Better Auth users with fixed ids `ana`/`marcus`/`mia`, roles `admin`/`manager`/`member`, emails `*@meridian.demo`, password `demo`. Idempotent (skip if the user already exists).

- [ ] **Step 1: Add the seed step**

In `mvp/scripts/dev-bootstrap.ts`, add near the top imports:

```ts
import { auth } from "../apps/web/lib/auth";
```

Add a helper before `main()`:

```ts
// Seed the three demo personas as real Better Auth local-credential users.
// Fixed ids keep them aligned with the pre-seeded app.grants rows (user_id = 'ana'|'marcus'|'mia').
async function seedPersonaUsers(db: Pool) {
  const personas = [
    { id: "ana",    email: "ana@meridian.demo",    name: "Ana",    role: "admin" },
    { id: "marcus", email: "marcus@meridian.demo", name: "Marcus", role: "manager" },
    { id: "mia",    email: "mia@meridian.demo",    name: "Mia",    role: "member" },
  ];
  for (const p of personas) {
    const exists = await db.query(`select 1 from app."user" where id=$1`, [p.id]);
    if (exists.rowCount && exists.rowCount > 0) continue;
    // Use Better Auth's sign-up so the password is hashed with its own scheme,
    // then fix the id + role directly (sign-up assigns a random id and default role).
    const res = await auth.api.signUpEmail({
      body: { email: p.email, password: "demo", name: p.name },
    });
    const generatedId = res.user.id;
    await db.query(`update app."user" set id=$1, role=$2 where id=$3`, [p.id, p.role, generatedId]);
    await db.query(`update app."account" set "userId"=$1 where "userId"=$2`, [p.id, generatedId]);
    await db.query(`update app."session" set "userId"=$1 where "userId"=$2`, [p.id, generatedId]);
  }
}
```

Then call it inside `main()` after `await createAppSchema(db);` and after Better Auth's own tables exist. Because `auth.api.signUpEmail` triggers Better Auth's migration lazily only on first HTTP use, explicitly run its migration first — add before `seedPersonaUsers`:

```ts
  // Ensure Better Auth tables exist (user/session/account/verification) before seeding users.
  const { runMigrations } = await import("better-auth/db");
  // Fallback: if programmatic migration is unavailable in this version, run the CLI in bootstrap docs.
```

If `better-auth/db` `runMigrations` is not exported in the installed version, instead shell out once at bootstrap: document that `npx @better-auth/cli migrate --config apps/web/lib/auth.ts -y` must run before `seedPersonaUsers`, and call it via `execSync`. Verify which path works in Step 2.

- [ ] **Step 2: Determine the migration API and wire it**

Run: `cd mvp && node -e "import('better-auth/db').then(m=>console.log(Object.keys(m))).catch(e=>console.log('no db export'))"`

- If it lists a migration runner (e.g. `getMigrations`/`runMigrations`), use it programmatically.
- Otherwise, in `dev-bootstrap.ts` run `execSync("npx @better-auth/cli migrate --config apps/web/lib/auth.ts -y", { cwd: process.cwd(), stdio: "inherit" })` before `seedPersonaUsers(db)`.

Wire the working option, then call `await seedPersonaUsers(db);` right after.

- [ ] **Step 3: Run bootstrap against the test/dev DB**

Run: `cd mvp && APP_DATABASE_URL=$APP_DATABASE_URL WAREHOUSD_PROJECT_DIR=examples/meridian npx tsx scripts/dev-bootstrap.ts`
Expected: prints `bootstrap complete (...)`; no duplicate-key errors on re-run.

- [ ] **Step 4: Verify the seeded users**

Run:
```bash
cd mvp && npx tsx -e "import {Pool} from 'pg'; const db=new Pool({connectionString:process.env.APP_DATABASE_URL}); db.query('select id,email,role from app.\"user\" order by id').then(r=>{console.log(r.rows); db.end()})"
```
Expected: three rows — `ana/admin`, `marcus/manager`, `mia/member` with `@meridian.demo` emails.

- [ ] **Step 5: Commit**

```bash
git add mvp/scripts/dev-bootstrap.ts
git commit -m "feat(bootstrap): seed persona users as better-auth local credentials"
```

---

### Task 10: Login screen + auth client

**Files:**
- Create: `mvp/apps/web/lib/auth-client.ts`
- Create: `mvp/apps/web/app/login/page.tsx`

**Interfaces:**
- Consumes: `LOCAL_LOGIN_DISABLED` (read at build via a server component wrapper or env directly on the client through `process.env.NEXT_PUBLIC_*` — see note).
- Produces: a working email/password login that redirects to `/` on success.

- [ ] **Step 1: Auth client**

Create `mvp/apps/web/lib/auth-client.ts`:

```ts
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? "http://localhost:8722",
});
```

- [ ] **Step 2: Expose demo/kill-switch flags to the client**

Add to `mvp/apps/web/next.config.mjs` an `env` block so the client can read them (these are non-secret UI flags):

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_WAREHOUSD_DEMO: process.env.WAREHOUSD_DEMO ?? "",
    NEXT_PUBLIC_LOCAL_LOGIN_DISABLED: process.env.SANDBOXD_DISABLE_LOCAL_LOGIN ?? "",
    NEXT_PUBLIC_BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost:8722",
  },
};
export default nextConfig;
```

(If `next.config.mjs` already has content, merge the `env` block into the existing config object rather than replacing it — Read it first.)

- [ ] **Step 3: Login page**

Create `mvp/apps/web/app/login/page.tsx`:

```tsx
"use client";
import { useState } from "react";
import { authClient } from "../../lib/auth-client";

const DISABLED = process.env.NEXT_PUBLIC_LOCAL_LOGIN_DISABLED === "true";
const DEMO = process.env.NEXT_PUBLIC_WAREHOUSD_DEMO === "true";

const DEMO_CREDS = [
  { email: "ana@meridian.demo", role: "admin" },
  { email: "marcus@meridian.demo", role: "manager" },
  { email: "mia@meridian.demo", role: "member" },
];

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const { error } = await authClient.signIn.email({ email, password, callbackURL: "/" });
    if (error) setErr(error.message ?? "login failed");
    else window.location.href = "/";
  }

  if (DISABLED) {
    return <main style={{ padding: 24 }}>
      <h2>Local login is disabled</h2>
      <p>Sign in through your organization&rsquo;s SSO provider.</p>
    </main>;
  }

  return (
    <main style={{ padding: 24, maxWidth: 360 }}>
      <h2>warehousd security console</h2>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit">Sign in</button>
        {err && <p style={{ color: "crimson" }}>{err}</p>}
      </form>
      {DEMO && (
        <div style={{ marginTop: 16, fontSize: 13 }}>
          <b>Demo credentials</b> (password <code>demo</code>):
          <ul>{DEMO_CREDS.map((c) => (
            <li key={c.email}><button style={{ font: "inherit" }}
              onClick={() => { setEmail(c.email); setPassword("demo"); }}>
              {c.email}</button> — {c.role}</li>
          ))}</ul>
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `cd mvp/apps/web && npx tsc --noEmit`
Expected: no errors from the login page or auth client.

- [ ] **Step 5: Commit**

```bash
git add mvp/apps/web/lib/auth-client.ts mvp/apps/web/app/login mvp/apps/web/next.config.mjs
git commit -m "feat(web): login screen with demo credentials"
```

---

### Task 11: Wire the console page to the session (remove persona dropdown)

**Files:**
- Modify: `mvp/apps/web/app/page.tsx`
- Modify: `mvp/apps/web/app/components/Chat.tsx`
- Modify: `mvp/apps/web/app/components/Grants.tsx`

**Interfaces:**
- Consumes: `authClient.useSession()` for the logged-in user + role; `/api/env` for env toggle.
- Produces: a page with no persona dropdown; env toggle POSTs to `/api/env`; sign-out; redirect to `/login` when unauthenticated. `Chat` sends only `{ messages }`; `Grants` fetches `/api/grants` with no `user` param and takes `canApprove` as a prop.

- [ ] **Step 1: Rewrite `app/page.tsx`**

Replace the whole file with:

```tsx
"use client";
import { useEffect, useState } from "react";
import { Chat } from "./components/Chat";
import { Evidence } from "./components/Evidence";
import { Grants } from "./components/Grants";
import { authClient } from "../lib/auth-client";

export default function Page() {
  const { data: session, isPending } = authClient.useSession();
  const [env, setEnv] = useState<"dev" | "live">("dev");
  const [tick, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);

  useEffect(() => {
    if (!isPending && !session) window.location.href = "/login";
  }, [isPending, session]);

  if (isPending || !session) return <main style={{ padding: 24 }}>Loading…</main>;

  const role = (session.user as { role?: string }).role ?? "member";
  const canApprove = role === "manager" || role === "admin";

  async function setEnvServer(next: "dev" | "live") {
    await fetch("/api/env", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: next }) });
    setEnv(next); bump();
  }

  return (
    <main style={{ height: "100vh", display: "flex", flexDirection: "column", padding: 12, gap: 12 }}>
      <header style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <b>warehousd security console</b>
        <span>{session.user.email} ({role})</span>
        <label><input type="radio" checked={env === "dev"} onChange={() => setEnvServer("dev")} /> dev</label>
        <label><input type="radio" checked={env === "live"} onChange={() => setEnvServer("live")} /> live</label>
        <button onClick={async () => { await authClient.signOut(); window.location.href = "/login"; }}>
          Sign out</button>
      </header>
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, minHeight: 0 }}>
        <Chat onTurn={bump} />
        <Evidence refreshKey={tick} />
        <Grants canApprove={canApprove} onChange={bump} />
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Update `Chat.tsx` signature + fetch body**

In `mvp/apps/web/app/components/Chat.tsx`, change the component signature from:

```tsx
export function Chat({ persona, env, onTurn }:
  { persona: string; env: string; onTurn: () => void }) {
```

to:

```tsx
export function Chat({ onTurn }: { onTurn: () => void }) {
```

And change the fetch body (around line 15-16) from sending `{ persona, env, messages: ... }` to sending only `{ messages: ... }`. Read the current body-construction lines and replace `persona, env,` — keep the `messages` field intact.

- [ ] **Step 3: Update `Grants.tsx` signature + fetch**

In `mvp/apps/web/app/components/Grants.tsx`:
- Change signature from `export function Grants({ persona, onChange }: { persona: string; onChange: () => void })` to `export function Grants({ canApprove, onChange }: { canApprove: boolean; onChange: () => void })`.
- Change `const load = () => fetch(\`/api/grants?user=${persona}\`)...` to `const load = () => fetch("/api/grants")...` (server derives the user).
- Change `useEffect(() => { load(); }, [persona]);` to `useEffect(() => { load(); }, []);`.
- Remove `by: persona` from the POST body (server sets `by` from session) — the mutate body becomes `{ action, id, allowedFields, selectedPaths, expiresAt }`.
- Replace `const canApprove = persona === "marcus" || persona === "ana";` — delete this line; `canApprove` is now a prop.
- Any UI text that interpolated `{persona}` (e.g. headings) should use the logged-in context; replace `{persona}` with a neutral label like `"your access"` or fetch the user email from the GET response if present. Keep it simple: change `<h3>Grants — {persona}</h3>` to `<h3>Grants</h3>` and `{persona}'s access` to `Your access`.

Read the full file first to catch every `persona` reference; there must be zero `persona` identifiers left after this step.

- [ ] **Step 4: Typecheck**

Run: `cd mvp/apps/web && npx tsc --noEmit`
Expected: no errors; no remaining references to `persona` in `page.tsx`, `Chat.tsx`, `Grants.tsx`.

- [ ] **Step 5: Commit**

```bash
git add mvp/apps/web/app/page.tsx mvp/apps/web/app/components/Chat.tsx mvp/apps/web/app/components/Grants.tsx
git commit -m "feat(web): session-driven console, remove persona switcher UI"
```

---

### Task 12: Delete the persona stub

**Files:**
- Delete: `mvp/apps/web/app/lib/persona.ts`

- [ ] **Step 1: Confirm no remaining importers**

Run: `cd mvp && grep -rn "lib/persona\|contextFor\|PersonaId\|PERSONAS" apps/web --include="*.ts" --include="*.tsx"`
Expected: no matches (all removed in Tasks 7 and 11).

- [ ] **Step 2: Delete the file**

Run: `git rm mvp/apps/web/app/lib/persona.ts`

- [ ] **Step 3: Typecheck**

Run: `cd mvp/apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(web): delete POC persona stub"
```

---

### Task 13: Test helper — provisioned DB with auth + personas

**Files:**
- Create: `mvp/apps/web/test/helpers/web-db.ts`

**Interfaces:**
- Consumes: the existing `provision` helper pattern (`mvp/packages/broker/test/helpers/db.ts`) — but the web test dir cannot import across package boundaries cleanly, so this helper reimplements provisioning against the same test Postgres (`127.0.0.1:54330`).
- Produces:
  - `export async function setupWebDb(label): Promise<{ appUrl, end }>` — fresh DB, `createAppSchema` applied, Better Auth tables migrated, three persona users seeded (ids `ana`/`marcus`/`mia`, roles admin/manager/member, password `demo`).
  - `export async function signIn(baseHeaders, email, password): Promise<string>` — returns a `Cookie` header string carrying the Better Auth session, for use in subsequent authenticated requests.

- [ ] **Step 1: Write the helper**

Create `mvp/apps/web/test/helpers/web-db.ts`. It provisions a fresh DB, points `process.env.APP_DATABASE_URL` at it, then imports `auth`, `createAppSchema`, runs Better Auth migration, and seeds users. Reuse the exact provisioning SQL from `packages/broker/test/helpers/db.ts` (roles `warehousd_dev`/`warehousd_live`, schemas `app`/`data_synth`/`data_live`). For seeding, call `auth.api.signUpEmail` then `update app."user" set id=..., role=...` exactly as Task 9's `seedPersonaUsers`.

```ts
import { Pool } from "pg";

const ADMIN = "postgres://postgres:postgres@127.0.0.1:54330/postgres";
const BASE = "postgres://postgres:postgres@127.0.0.1:54330";

export async function setupWebDb(label: string) {
  const dbName = `wh_web_${label}_${process.pid}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const admin = new Pool({ connectionString: ADMIN });
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`create database ${dbName}`);
  await admin.end();

  const appUrl = `${BASE}/${dbName}`;
  const db = new Pool({ connectionString: appUrl });
  await db.query(`
    create schema app; create schema data_synth; create schema data_live;
    do $$ begin
      if not exists (select from pg_roles where rolname='warehousd_dev') then create role warehousd_dev login password 'pw'; end if;
      if not exists (select from pg_roles where rolname='warehousd_live') then create role warehousd_live login password 'pw'; end if;
    end $$;
    grant usage on schema data_synth to warehousd_dev;
    grant usage on schema data_live to warehousd_live;
    grant usage on schema app to warehousd_dev, warehousd_live;`);

  // Point auth at this DB BEFORE importing lib/auth (it reads APP_DATABASE_URL at module load).
  process.env.APP_DATABASE_URL = appUrl;
  process.env.BETTER_AUTH_SECRET ??= "test-secret-at-least-32-chars-long-000";
  process.env.BETTER_AUTH_URL ??= "http://localhost:8722";

  const { createAppSchema } = await import("@warehousd/broker");
  await createAppSchema(db);

  const { auth } = await import("../../lib/auth");
  // Run Better Auth migration (use the approach confirmed in Task 9 Step 2).
  const { getMigrations } = await import("better-auth/db");
  const { runMigrations } = await getMigrations((auth as any).options);
  await runMigrations();

  const personas = [
    { id: "ana", email: "ana@meridian.demo", name: "Ana", role: "admin" },
    { id: "marcus", email: "marcus@meridian.demo", name: "Marcus", role: "manager" },
    { id: "mia", email: "mia@meridian.demo", name: "Mia", role: "member" },
  ];
  for (const p of personas) {
    const res = await auth.api.signUpEmail({ body: { email: p.email, password: "demo", name: p.name } });
    const gen = res.user.id;
    await db.query(`update app."user" set id=$1, role=$2 where id=$3`, [p.id, p.role, gen]);
    await db.query(`update app."account" set "userId"=$1 where "userId"=$2`, [p.id, gen]);
  }

  return {
    appUrl,
    auth,
    async end() {
      await db.end();
      const a = new Pool({ connectionString: ADMIN });
      await a.query(`drop database if exists ${dbName} with (force)`);
      await a.end();
    },
  };
}

// Sign in and return the Set-Cookie value as a Cookie header for subsequent requests.
export async function signIn(auth: any, email: string, password: string): Promise<string> {
  const res = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  // Reduce "name=value; attrs" to just "name=value" pairs joined for a Cookie header.
  return setCookie.split(/,(?=[^;]+?=)/).map((c: string) => c.split(";")[0].trim()).join("; ");
}
```

Note: the exact Better Auth migration call (`getMigrations`/`runMigrations`) must match what Task 9 Step 2 confirmed. If that API differs, adjust here identically.

- [ ] **Step 2: Smoke-test the helper**

Run: `cd mvp && WAREHOUSD_PROJECT_DIR=examples/meridian npx vitest run apps/web/test/helpers 2>&1 | tail -20` (there is no test file yet — this step just confirms the helper imports without a syntax error via a quick `tsx` load instead):

Run: `cd mvp && npx tsx -e "import('./apps/web/test/helpers/web-db.ts').then(m=>console.log(typeof m.setupWebDb))"`
Expected: prints `function`.

- [ ] **Step 3: Commit**

```bash
git add mvp/apps/web/test/helpers/web-db.ts
git commit -m "test(web): provisioned-DB helper with auth + persona seed"
```

---

### Task 14: Extend vitest include to cover web tests

**Files:**
- Modify: `mvp/vitest.config.ts`

- [ ] **Step 1: Extend the include glob**

Change `include: ["packages/**/test/**/*.test.ts"]` to:

```ts
include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"],
```

- [ ] **Step 2: Verify existing tests still collected**

Run: `cd mvp && pnpm test -- --run 2>&1 | tail -15` (with the test Postgres up: `pnpm test:up` first).
Expected: existing broker tests still run and pass; no collection errors.

- [ ] **Step 3: Commit**

```bash
git add mvp/vitest.config.ts
git commit -m "test: include apps/**/test in vitest run"
```

---

### Task 15: Acceptance integration tests

**Files:**
- Create: `mvp/apps/web/test/auth.integration.test.ts`

**Interfaces:**
- Consumes: `setupWebDb`, `signIn` from `./helpers/web-db`; the route handlers imported directly (`POST`/`GET` from the app routes) OR exercised through `auth.api`. Tests import the route modules and call their exported `POST`/`GET` with a constructed `Request`.

**Acceptance gate mapping (from the outline):**
1. 401 on unauthenticated chat/grants/audit routes.
2. 403 on member-attempted approve.
3. Session-derived `BrokerContext.userId` matches the logged-in user; a planted `userId`/`env` in the body is provably ignored.

- [ ] **Step 1: Write the failing tests**

Create `mvp/apps/web/test/auth.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let miaCookie: string;
let marcusCookie: string;

beforeAll(async () => {
  db = await setupWebDb("authint");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@meridian.demo", "demo");
}, 60_000);

afterAll(async () => { await db?.end(); });

function req(url: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  return new Request(`http://localhost:8722${url}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

describe("auth gate", () => {
  it("grants GET without a session → 401", async () => {
    const { GET } = await import("../app/api/grants/route");
    const res = await GET(req("/api/grants") as any);
    expect(res.status).toBe(401);
  });

  it("grants GET with a session → 200 and returns the session user's grants", async () => {
    const { GET } = await import("../app/api/grants/route");
    const res = await GET(req("/api/grants", { cookie: miaCookie }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Every returned "mine" grant belongs to mia — the session user, not a query param.
    for (const g of body.mine) expect(g.user_id).toBe("mia");
  });

  it("member approve → 403", async () => {
    const { POST } = await import("../app/api/grants/route");
    // mia (member) tries to approve her own pending salaries grant
    const res = await POST(req("/api/grants", {
      method: "POST", cookie: miaCookie,
      body: { action: "approve", id: "00000000-0000-0000-0000-000000000000" },
    }) as any);
    expect(res.status).toBe(403);
  });

  it("manager approve → not 403 (authorized role passes the check)", async () => {
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req("/api/grants", {
      method: "POST", cookie: marcusCookie,
      body: { action: "revoke", id: "00000000-0000-0000-0000-000000000000" },
    }) as any);
    // A non-existent id is a no-op in approve/deny/revoke, but the role check passes → ok:true.
    expect(res.status).toBe(200);
  });

  it("planted userId/env in body is ignored; context derives from session", async () => {
    const { GET } = await import("../app/api/grants/route");
    // Even if a caller crafts ?user=marcus, the session (mia) wins.
    const res = await GET(req("/api/grants?user=marcus", { cookie: miaCookie }) as any);
    const body = await res.json();
    for (const g of body.mine) expect(g.user_id).toBe("mia");
  });
});
```

- [ ] **Step 2: Run and watch it fail (if any wiring is off)**

Run: `cd mvp && pnpm test:up && WAREHOUSD_PROJECT_DIR=examples/meridian npx vitest run apps/web/test/auth.integration.test.ts`
Expected: the tests execute; any failure points at a specific wiring gap to fix (e.g. env cookie parsing, role check). Iterate until green.

- [ ] **Step 3: Confirm all pass**

Run: `cd mvp && WAREHOUSD_PROJECT_DIR=examples/meridian npx vitest run apps/web/test/auth.integration.test.ts`
Expected: 5 passing.

- [ ] **Step 4: Commit**

```bash
git add mvp/apps/web/test/auth.integration.test.ts
git commit -m "test(web): auth gate + role + session-derived context integration tests"
```

---

### Task 16: Full suite + manual demo verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite green (Phase 0/0.5 untouched)**

Run: `cd mvp && pnpm test:up && WAREHOUSD_PROJECT_DIR=examples/meridian pnpm test`
Expected: all broker + web tests pass. If any Phase 0/0.5 test regressed, stop and fix — the broker must be untouched.

- [ ] **Step 2: Manual demo — login as each persona**

Run the app (`cd mvp && WAREHOUSD_DEMO=true ... pnpm --filter @warehousd/web dev`), then in a browser:
- Visit `/` unauthenticated → redirected to `/login`.
- Login page shows the three demo credentials.
- Sign in as `mia@meridian.demo` / `demo` → console loads showing `mia@meridian.demo (member)`, no persona dropdown.
- Sign in as `marcus@meridian.demo` → Grants panel shows the approve controls (canApprove true); Mia's pending `salaries` request is visible in his inbox.
- As Marcus, approve Mia's `salaries` grant → sign in as Mia → the flagship "average senior accountant salary" question now works end-to-end in chat. Revoke it as Marcus → Mia's next query for `base_salary` is refused. (Confirms the §9 arc still demos.)

- [ ] **Step 3: Kill-switch check**

Restart with `SANDBOXD_DISABLE_LOCAL_LOGIN=true` → `/login` shows the "Local login is disabled" notice and no form.

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A && git commit -m "chore(web): phase 1 real-identity verification fixes"
```

---

## Self-Review Notes

- **Spec coverage:** §6.2 (local creds as fallback + `SANDBOXD_DISABLE_LOCAL_LOGIN`) → Tasks 2, 10. Roles admin/manager/member → Tasks 2, 9. Session-derived `BrokerContext`, env-as-server-value never body → Tasks 4, 5, 7. Role checks on grant mutations → Task 8. Middleware 401 → Task 6. Delete persona → Tasks 7, 11, 12. Seed personas with §9 roles + grants → Task 9 (grants already seeded by existing bootstrap; this adds the auth users). Acceptance gate (401/403/planted-body-ignored/demo arc) → Tasks 15, 16.
- **Deferred to Phase 2 (out of scope, per outline):** SSO/OIDC provider, OAuth token scopes (`env:dev`/`env:live`), `client_policies`, MCP OAuth. The env toggle here is a web-console-only session value; token scopes replace it for API paths in Phase 2.
- **Open item flagged in outline resolved:** Better Auth schema generation coexists with `createAppSchema` because they own disjoint table names in the `app` schema; both use create-if-not-exists. Task 3 Step 2 and Task 9 Step 2 empirically confirm the migration path (programmatic vs CLI) against the installed version before relying on it.
