# Phase 2 — OAuth 2.1 Provider + Env-as-Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn warehousd's web app into an OAuth 2.1 authorization server (Better Auth's `mcp`/`oidc-provider` plugins) where the `env:dev` / `env:live` scopes are computed and enforced entirely server-side at token issuance and refresh, per `docs/SPECS.md` §6 requirements 4–6 and §6.1.

**Architecture:** `betterAuth()` in `lib/auth.ts` gains the `mcp` plugin (which wraps `oidc-provider`) plus a small hand-written `envScopePlugin` that hooks `/mcp/authorize` (before) and `/mcp/token` (after) to intersect requested scopes against `app.client_policies.allowed_scopes` and the user's live grants. A new `app.client_policies` table (Drizzle + raw DDL, mirroring the existing `app.grants`/`app.collections` pattern) stores the per-client allow-list. `lib/broker-context.ts` becomes the sole `BrokerContext` constructor for token-authenticated paths, verifying tokens via `auth.api.getMcpSession`.

**Tech Stack:** Better Auth `mcp`/`oidc-provider` plugins (bumped to `^1.6.24`), Drizzle (`pgSchema("app")`), `pg` `Pool`, Next.js route handlers, Vitest + the existing `setupWebDb`/`provision` test helpers.

## Global Constraints

- Access tokens: 15 minutes (`accessTokenExpiresIn: 900`). Refresh tokens per Better Auth default (7 days) unless a task says otherwise.
- Exactly two scopes exist: `env:dev`, `env:live`. A token never carries both.
- Tokens carry only `sub` (user id), `client_id`, and the env scope — no grant data, ever.
- `app.client_policies.allowed_scopes` defaults to `{env:dev}`. A **missing** policy row is treated as `{env:dev}`, never as allow-all.
- Dynamically registered (RFC 7591) clients get `allowed_scopes = {env:dev, env:live}` at registration time.
- Manually created clients get `allowed_scopes = {env:dev}` always — no creation-time override.
- Promotion/demotion of a client's `env:live` scope is manager/admin-only, same role-check pattern as `app/api/grants/route.ts`.
- Rule 2 is spec-literal: a `NULL expires_at` on an otherwise-approved live grant does **not** confer `env:live` eligibility (only `expires_at > now()` counts).
- Scope rules re-run on every refresh — Better Auth's own refresh handler does **not** do this (it copies the old token's scopes verbatim), so this plan corrects it explicitly (Task 7).
- One `betterAuth()` instance. OAuth plugins are added to the existing instance in `lib/auth.ts` — never a second instance.
- `lib/session.ts`'s `deriveContext` stays the sole `BrokerContext` constructor for cookie/session paths. `lib/broker-context.ts` becomes the sole constructor for token paths. Both files must say so in a comment (two-constructor invariant).
- Test DB: `docker compose -f docker-compose.test.yml up -d --wait` (port 54330) must be running; `pnpm install` must have been run at the repo root (`mvp/`) before any task's tests will execute.

---

## Task 0: Environment bootstrap + Better Auth version bump

**Files:**
- Modify: `mvp/apps/web/package.json` (`better-auth` version)
- Test: none (infra task) — verified by running the existing suite

**Interfaces:**
- Produces: a working `pnpm install`, a running test Postgres, and confirmation that `better-auth/plugins` exports `mcp` and `oidcProvider` at the installed version — every later task depends on this.

- [ ] **Step 1: Bump the pin**

Edit `mvp/apps/web/package.json`:

```diff
-    "better-auth": "^1.2.0",
+    "better-auth": "^1.6.24",
```

- [ ] **Step 2: Install and bring up the test database**

```bash
cd mvp
pnpm install
pnpm test:up
```

Expected: install completes with no `ERESOLVE` errors; `docker compose ps` shows the `db` service healthy on `127.0.0.1:54330`.

- [ ] **Step 3: Confirm the plugin exports exist at the installed version**

```bash
node -e "import('better-auth/plugins').then(m => console.log(typeof m.mcp, typeof m.oidcProvider))"
```

Expected output: `function function`. If either is `undefined`, stop — the installed version doesn't match what this plan assumes; re-check `npm view better-auth versions` and update this task before continuing.

- [ ] **Step 4: Run the existing suite to establish a clean baseline**

```bash
pnpm test
```

Expected: all currently-passing tests still pass (the pre-existing `db-roles.test.ts` "test 5 (partial)" and Phase 1 `auth.integration.test.ts` must be green — these are the regression floor for everything below).

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore: bump better-auth to ^1.6.24 for mcp/oidc-provider plugins"
```

---

## Task 1: `app.client_policies` table

**Files:**
- Modify: `mvp/packages/broker/src/db/app-schema.ts` (Drizzle table)
- Modify: `mvp/packages/broker/src/db/migrate-app.ts` (raw DDL, idempotent)
- Test: `mvp/packages/broker/test/app-schema.test.ts` (extend — same file already covers `createAppSchema`)

**Interfaces:**
- Produces: `app.client_policies(client_id text pk, display_name text, allowed_scopes text[] not null default '{env:dev}', promoted_at timestamptz, promoted_by text)`, created by `createAppSchema`.
- Consumes: the OAuth client table Better Auth's `mcp` plugin creates (`oauthApplication` model) — **name must be discovered empirically in Step 1** before the FK can be written.

- [ ] **Step 1: Discover the actual table name Better Auth creates for OAuth clients**

The `mcp` plugin's client model is named `oauthApplication` (camelCase) internally; Better Auth's pg adapter does not snake_case identifiers (the existing test helper already queries `app."account"`, `app."userId"` — quoted camelCase). Confirm before writing a DDL that references it:

```bash
cd mvp
# temporary: point a scratch DB at the CLI migrate command and inspect the result
docker exec -i $(docker compose -f docker-compose.test.yml ps -q db) psql -U postgres -c "create database wh_probe"
APP_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:54330/wh_probe" \
  npx @better-auth/cli migrate --config apps/web/lib/auth.ts -y
docker exec -i $(docker compose -f docker-compose.test.yml ps -q db) \
  psql -U postgres -d wh_probe -c "select table_name from information_schema.tables where table_schema='app'"
docker exec -i $(docker compose -f docker-compose.test.yml ps -q db) psql -U postgres -c "drop database wh_probe"
```

This must be re-run once Task 2 has added the `mcp` plugin to `lib/auth.ts` (right now `lib/auth.ts` has no OAuth plugin, so this table won't exist yet — **do this step after Task 2, Step 1 is done**, then come back and finish this task). Record the exact table name found (expected: `"oauthApplication"`, quoted camelCase) — use it verbatim in Step 2 below. If the table turns out unique-constrained on `clientId` (it is, per the plugin's schema — `clientId: { unique: true }`), the FK is valid.

- [ ] **Step 2: Add the Drizzle table**

In `mvp/packages/broker/src/db/app-schema.ts`, add after `terms`:

```ts
export const clientPolicies = app.table("client_policies", {
  clientId: text("client_id").primaryKey(),
  displayName: text("display_name"),
  allowedScopes: text("allowed_scopes").array().notNull().default(sql`'{env:dev}'`),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
  promotedBy: text("promoted_by"),
});
```

Add `sql` to the existing `drizzle-orm/pg-core` import line's sibling import: `import { sql } from "drizzle-orm";` at the top of the file.

- [ ] **Step 3: Add the raw DDL to `createAppSchema`**

In `mvp/packages/broker/src/db/migrate-app.ts`, append a new block (after the taxonomy block, before the final grants):

```ts
  // client_policies: per-OAuth-client env:live allow-list (§6.1). FK target table name was
  // confirmed empirically against the installed better-auth version (Task 1 Step 1) — if a
  // future better-auth bump renames the oauth client table, this FK will fail on create and
  // must be updated to match.
  await db.query(`
    create table if not exists app.client_policies (
      client_id text primary key,
      display_name text,
      allowed_scopes text[] not null default '{env:dev}',
      promoted_at timestamptz,
      promoted_by text,
      foreign key (client_id) references app."oauthApplication"("clientId") on delete cascade);
  `);
```

Replace `app."oauthApplication"("clientId")` with whatever Step 1 actually found if it differs.

- [ ] **Step 4: Write the failing test**

In `mvp/packages/broker/test/app-schema.test.ts`, find the existing test that asserts `createAppSchema` creates `app.grants`/`app.collections` (read the file first to match its exact style), and add:

```ts
it("creates app.client_policies with the default allow-list", async () => {
  const r = await admin.query(`
    insert into app.client_policies (client_id, display_name) values ('c1', 'Test Client')
    returning allowed_scopes`);
  expect(r.rows[0].allowed_scopes).toEqual(["env:dev"]);
});

it("client_policies is idempotent under repeated createAppSchema calls", async () => {
  await expect(createAppSchema(admin)).resolves.not.toThrow();
});
```

Note: this test file's `admin` pool is **not** connected to a DB with the `oauthApplication` table yet (only `createAppSchema` runs there, not Better Auth's migration), so the FK in Step 3 will make the `insert` in the first new test fail unless the test first creates a stub `oauthApplication` row. Add this to the test's `beforeAll` (or immediately before the insert, matching whatever setup pattern the file already uses):

```ts
await admin.query(`
  create table if not exists app."oauthApplication" ("clientId" text primary key);
  insert into app."oauthApplication" ("clientId") values ('c1') on conflict do nothing;
`);
```

- [ ] **Step 5: Run the test to verify it fails**

```bash
cd mvp && npx vitest run packages/broker/test/app-schema.test.ts
```

Expected: FAIL — `relation "app.client_policies" does not exist`.

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd mvp && npx vitest run packages/broker/test/app-schema.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/broker/src/db/app-schema.ts packages/broker/src/db/migrate-app.ts packages/broker/test/app-schema.test.ts
git commit -m "feat(broker): add app.client_policies table"
```

---

## Task 2: Wire `mcp`/`oidc-provider` into `lib/auth.ts`

**Files:**
- Create: `mvp/apps/web/lib/oauth.ts`
- Modify: `mvp/apps/web/lib/auth.ts`
- Test: `mvp/apps/web/test/oauth.integration.test.ts`

**Interfaces:**
- Produces: `oauthOptions` (exported from `lib/oauth.ts`) consumed by `lib/auth.ts`'s `plugins` array. `auth.api.getMcpOAuthConfig`, `auth.api.registerMcpClient`, `auth.api.mcpOAuthAuthorize`, `auth.api.mcpOAuthToken` become available on the existing `auth` object.
- Consumes: `auth` from `./auth` (for the test only).

- [ ] **Step 1: Write `lib/oauth.ts` with base provider config (no scope hook yet)**

```ts
import { mcp } from "better-auth/plugins";

// env:dev / env:live are the ONLY scopes this plugin adds beyond Better Auth's OIDC defaults
// (openid, profile, email, offline_access). Rule enforcement (client policy intersection,
// live-grant eligibility, exactly-one-env, refresh re-evaluation) is added in lib/oauth.ts's
// envScopePlugin — see Tasks 3-6.
export const mcpPlugin = mcp({
  loginPage: "/login",
  oidcConfig: {
    scopes: ["env:dev", "env:live"],
    accessTokenExpiresIn: 900, // 15 min, per §6.1 rule 4
    allowDynamicClientRegistration: true,
  },
});
```

- [ ] **Step 2: Wire it into `lib/auth.ts`**

```diff
 import { betterAuth } from "better-auth";
 import { Pool } from "pg";
+import { mcpPlugin } from "./oauth";
```

```diff
   user: {
     additionalFields: {
       role: { type: "string", defaultValue: "member", input: false },
     },
   },
+  plugins: [mcpPlugin],
 });
```

- [ ] **Step 3: Write the failing test**

Create `mvp/apps/web/test/oauth.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb } from "./helpers/web-db";

let db: Awaited<ReturnType<typeof setupWebDb>>;

beforeAll(async () => { db = await setupWebDb("oauth"); }, 60_000);
afterAll(async () => { await db?.end(); });

describe("OAuth provider wiring", () => {
  it("exposes the well-known authorization server metadata", async () => {
    const res = await db.auth.api.getMcpOAuthConfig({ asResponse: true } as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scopes_supported).toEqual(expect.arrayContaining(["openid", "profile", "email", "offline_access"]));
    expect(body.token_endpoint).toMatch(/\/mcp\/token$/);
  });

  it("dynamic client registration creates a client", async () => {
    const res = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Test DCR Client" },
      asResponse: true,
    } as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clientId).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run to verify it fails**

```bash
cd mvp && npx vitest run apps/web/test/oauth.integration.test.ts
```

Expected: FAIL — `better-auth/plugins` has no `mcp` export at the old pinned version, or (if Task 0 already landed) fails because `lib/auth.ts` doesn't yet register the plugin. Confirm the failure is about the missing plugin, not an unrelated setup error.

- [ ] **Step 5: Run to verify it passes**

```bash
cd mvp && npx vitest run apps/web/test/oauth.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Finish Task 1's Step 1 (deferred table-name discovery)**

Now that `lib/auth.ts` has the `mcp` plugin, go back to Task 1 Step 1 and run the discovery query for real (a `setupWebDb` call already runs `@better-auth/cli migrate` — reuse the test DB from Step 3's run, or add a one-off `console.log` in this test to dump `information_schema.tables`). Confirm the FK in `migrate-app.ts` from Task 1 Step 3 matches. Adjust if it doesn't; re-run Task 1's tests.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/oauth.ts apps/web/lib/auth.ts apps/web/test/oauth.integration.test.ts
git commit -m "feat(web): wire Better Auth mcp/oidc-provider plugin into the auth instance"
```

---

## Task 3: `client_policies` data-layer helpers

**Files:**
- Create: `mvp/packages/broker/src/oauth/client-policies.ts`
- Modify: `mvp/packages/broker/src/index.ts` (export)
- Test: `mvp/packages/broker/test/client-policies.test.ts`

**Interfaces:**
- Produces: `getClientPolicy(app, clientId): Promise<{ clientId: string; allowedScopes: string[] }>` (missing row → `{ clientId, allowedScopes: ["env:dev"] }`, never throws), `setAllowedScopes(app, clientId, scopes, by): Promise<void>`, `hasApprovedLiveGrant(app, userId): Promise<boolean>`, `upsertClientPolicy(app, clientId, displayName, allowedScopes): Promise<void>`.
- Consumed by: Task 4 (rule 1), Task 5 (rule 2), Task 7 (rule 4 refresh), Task 8 (DCR bootstrap), Task 9 (manual client + promotion API).

- [ ] **Step 1: Write the failing tests**

Create `mvp/packages/broker/test/client-policies.test.ts`:

```ts
import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema } from "../src/db/migrate-app";
import { getClientPolicy, setAllowedScopes, hasApprovedLiveGrant, upsertClientPolicy } from "../src/oauth/client-policies";

let p: Provisioned, admin: Pool;
beforeAll(async () => {
  p = await provision("clientpolicies"); admin = new Pool({ connectionString: p.urls.admin });
  await admin.query(`create table if not exists app."oauthApplication" ("clientId" text primary key)`);
  await createAppSchema(admin);
});
afterAll(async () => { await admin.end(); await p.end(); });

beforeEach(async () => {
  await admin.query(`delete from app.client_policies`);
  await admin.query(`delete from app.grants`);
  await admin.query(`delete from app."oauthApplication"`);
});

it("missing policy row resolves to {env:dev}, never allow-all", async () => {
  const policy = await getClientPolicy(admin, "unknown-client");
  expect(policy.allowedScopes).toEqual(["env:dev"]);
});

it("upsertClientPolicy creates a row with the given scopes", async () => {
  await admin.query(`insert into app."oauthApplication" ("clientId") values ('c1')`);
  await upsertClientPolicy(admin, "c1", "Test Client", ["env:dev", "env:live"]);
  const policy = await getClientPolicy(admin, "c1");
  expect(policy.allowedScopes.sort()).toEqual(["env:dev", "env:live"]);
});

it("setAllowedScopes updates an existing row and stamps promoted_at/by", async () => {
  await admin.query(`insert into app."oauthApplication" ("clientId") values ('c1')`);
  await upsertClientPolicy(admin, "c1", "Test Client", ["env:dev"]);
  await setAllowedScopes(admin, "c1", ["env:dev", "env:live"], "ana");
  const r = await admin.query(`select allowed_scopes, promoted_by, promoted_at from app.client_policies where client_id='c1'`);
  expect(r.rows[0].allowed_scopes.sort()).toEqual(["env:dev", "env:live"]);
  expect(r.rows[0].promoted_by).toBe("ana");
  expect(r.rows[0].promoted_at).not.toBeNull();
});

it("hasApprovedLiveGrant: true only for approved, env=live, unexpired grants", async () => {
  await admin.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at) values
    ('u1','people',array['id'],'live','approved', now() + interval '1 day')`);
  expect(await hasApprovedLiveGrant(admin, "u1")).toBe(true);
});

it("hasApprovedLiveGrant: false when the only approved live grant has NULL expires_at (spec-literal rule 2)", async () => {
  await admin.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at) values
    ('u2','people',array['id'],'live','approved', null)`);
  expect(await hasApprovedLiveGrant(admin, "u2")).toBe(false);
});

it("hasApprovedLiveGrant: false when the grant is expired", async () => {
  await admin.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at) values
    ('u3','people',array['id'],'live','approved', now() - interval '1 day')`);
  expect(await hasApprovedLiveGrant(admin, "u3")).toBe(false);
});

it("hasApprovedLiveGrant: false for a dev-env grant even if approved and unexpired", async () => {
  await admin.query(`insert into app.grants (user_id,collection,allowed_fields,env,status,expires_at) values
    ('u4','people',array['id'],'dev','approved', now() + interval '1 day')`);
  expect(await hasApprovedLiveGrant(admin, "u4")).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd mvp && npx vitest run packages/broker/test/client-policies.test.ts
```

Expected: FAIL — `Cannot find module '../src/oauth/client-policies'`.

- [ ] **Step 3: Implement**

Create `mvp/packages/broker/src/oauth/client-policies.ts`:

```ts
import type { Pool } from "pg";

export type ClientPolicy = { clientId: string; allowedScopes: string[] };

export async function getClientPolicy(app: Pool, clientId: string): Promise<ClientPolicy> {
  const r = await app.query(`select allowed_scopes from app.client_policies where client_id=$1`, [clientId]);
  if (r.rowCount === 0) return { clientId, allowedScopes: ["env:dev"] };
  return { clientId, allowedScopes: r.rows[0].allowed_scopes };
}

export async function upsertClientPolicy(
  app: Pool, clientId: string, displayName: string | null, allowedScopes: string[],
): Promise<void> {
  await app.query(
    `insert into app.client_policies (client_id, display_name, allowed_scopes)
     values ($1,$2,$3)
     on conflict (client_id) do update set display_name=$2, allowed_scopes=$3`,
    [clientId, displayName, allowedScopes]);
}

export async function setAllowedScopes(
  app: Pool, clientId: string, allowedScopes: string[], by: string,
): Promise<void> {
  await app.query(
    `update app.client_policies set allowed_scopes=$2, promoted_at=now(), promoted_by=$3 where client_id=$1`,
    [clientId, allowedScopes, by]);
}

export async function hasApprovedLiveGrant(app: Pool, userId: string): Promise<boolean> {
  const r = await app.query(
    `select 1 from app.grants
     where user_id=$1 and env='live' and status='approved' and expires_at > now() limit 1`,
    [userId]);
  return (r.rowCount ?? 0) > 0;
}
```

- [ ] **Step 4: Export from the package barrel**

In `mvp/packages/broker/src/index.ts`, add:

```ts
export * from "./oauth/client-policies";
```

- [ ] **Step 5: Run to verify it passes**

```bash
cd mvp && npx vitest run packages/broker/test/client-policies.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/broker/src/oauth/client-policies.ts packages/broker/src/index.ts packages/broker/test/client-policies.test.ts
git commit -m "feat(broker): client_policies data-layer + hasApprovedLiveGrant"
```

---

## Task 4: Scope-issuance hook, rule 1 (client-policy intersection)

**Files:**
- Modify: `mvp/apps/web/lib/oauth.ts`
- Test: `mvp/apps/web/test/oauth-scope.integration.test.ts`

**Interfaces:**
- Consumes: `getClientPolicy` from `@warehousd/broker` (Task 3).
- Produces: `envScopePlugin(app: Pool)` added to `lib/auth.ts`'s `plugins` array, exported from `lib/oauth.ts`. Later tasks (5, 6, 7) extend this same plugin's `before`/`after` hook bodies in place.

- [ ] **Step 1: Write the failing test**

Create `mvp/apps/web/test/oauth-scope.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { upsertClientPolicy } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let miaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("oauthscope");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

describe("rule 1: dev-only client requesting env:live gets only env:dev", () => {
  it("rewrites the authorize query's scope before the client is ever shown a consent screen", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Dev Only Client" },
      asResponse: true,
    } as any);
    const { clientId } = await reg.json();
    // Force the dev-only policy (DCR default is {env:dev,env:live} — Task 8; here we
    // simulate a manually-created client's policy directly, since manual creation is Task 9).
    const app = getAppPool();
    await upsertClientPolicy(app, clientId, "Dev Only Client", ["env:dev"]);

    const res = await db.auth.api.mcpOAuthAuthorize({
      query: {
        client_id: clientId,
        response_type: "code",
        redirect_uri: "http://localhost:9999/callback",
        scope: "env:live openid",
        code_challenge: "test-challenge-000000000000000000000000000",
        code_challenge_method: "S256",
      },
      headers: { cookie: miaCookie } as any,
      asResponse: true,
    } as any);

    // Either a redirect to the consent page or an error — in both cases env:live must never
    // appear in the location/body. Assert on whichever the response actually is.
    const location = res.headers.get("location") ?? "";
    const bodyText = await res.text().catch(() => "");
    expect(location + bodyText).not.toContain("env:live");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd mvp && npx vitest run apps/web/test/oauth-scope.integration.test.ts
```

Expected: FAIL — `env:live` leaks through untouched (no hook exists yet to strip it).

- [ ] **Step 3: Implement the hook**

Rewrite `mvp/apps/web/lib/oauth.ts`:

```ts
import { mcp } from "better-auth/plugins";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { Pool } from "pg";
import { getClientPolicy } from "@warehousd/broker";

const ENV_SCOPES = ["env:dev", "env:live"] as const;

export const mcpPlugin = mcp({
  loginPage: "/login",
  oidcConfig: {
    scopes: ["env:dev", "env:live"],
    accessTokenExpiresIn: 900, // 15 min, per §6.1 rule 4
    allowDynamicClientRegistration: true,
  },
});

// §6.1 rules 1-4. Intersects the requested scope with the client's allow-list (rule 1) and
// the user's live-grant eligibility (rule 2) BEFORE Better Auth's own authorize handler runs,
// by rewriting ctx.query.scope in place — so escalation is impossible by construction, not by
// after-the-fact validation. Rules 3 (env picker) and 4 (refresh re-evaluation) are added in
// Tasks 6 and 7 respectively, in the same hook bodies below.
export function envScopePlugin(app: Pool) {
  return {
    id: "env-scope",
    hooks: {
      before: [
        {
          matcher: (ctx: { path: string }) => ctx.path === "/mcp/authorize",
          handler: createAuthMiddleware(async (ctx: any) => {
            const clientId = String(ctx.query?.client_id ?? "");
            const requested = String(ctx.query?.scope ?? "").split(" ").filter(Boolean);
            const requestedEnv = requested.filter((s) => (ENV_SCOPES as readonly string[]).includes(s));
            if (requestedEnv.length === 0) return;

            const policy = await getClientPolicy(app, clientId);
            const survivors = requestedEnv.filter((s) => policy.allowedScopes.includes(s));

            const others = requested.filter((s) => !(ENV_SCOPES as readonly string[]).includes(s));
            ctx.query = { ...ctx.query, scope: [...others, ...survivors].join(" ") };
          }),
        },
      ],
    },
  };
}
```

- [ ] **Step 4: Wire `envScopePlugin` into `lib/auth.ts`**

```diff
 import { betterAuth } from "better-auth";
 import { Pool } from "pg";
-import { mcpPlugin } from "./oauth";
+import { mcpPlugin, envScopePlugin } from "./oauth";
+
+const appPool = new Pool({
+  connectionString: process.env.APP_DATABASE_URL,
+  options: "-c search_path=app",
+});
```

```diff
-  database: new Pool({
-    connectionString: process.env.APP_DATABASE_URL,
-    options: "-c search_path=app",
-  }),
+  database: appPool,
```

```diff
-  plugins: [mcpPlugin],
+  plugins: [mcpPlugin, envScopePlugin(appPool)],
```

(Reuses the single `appPool` for both Better Auth's own storage and the scope hook's `client_policies`/`grants` queries — no second pool.)

- [ ] **Step 5: Run to verify it passes**

```bash
cd mvp && npx vitest run apps/web/test/oauth-scope.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Re-run the full suite to check for regressions from the `database: appPool` refactor**

```bash
cd mvp && pnpm test
```

Expected: all green, including `oauth.integration.test.ts` and Phase 1's `auth.integration.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/oauth.ts apps/web/lib/auth.ts apps/web/test/oauth-scope.integration.test.ts
git commit -m "feat(web): scope-issuance rule 1 — intersect requested scope with client_policies"
```

---

## Task 5: Scope-issuance hook, rule 2 (live-grant eligibility)

**Files:**
- Modify: `mvp/apps/web/lib/oauth.ts`
- Test: `mvp/apps/web/test/oauth-scope.integration.test.ts` (extend)

**Interfaces:**
- Consumes: `hasApprovedLiveGrant` from `@warehousd/broker` (Task 3), `getSessionFromCtx` from `better-auth/api`.

- [ ] **Step 1: Write the failing test**

Add to `mvp/apps/web/test/oauth-scope.integration.test.ts`:

```ts
import { approveGrant, requestGrant } from "@warehousd/broker";

describe("rule 2: env:live requires an approved, unexpired live grant", () => {
  it("live-allowed client + user with NO approved live grant → env:live silently dropped", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Live Allowed Client" },
      asResponse: true,
    } as any);
    const { clientId } = await reg.json();
    const app = getAppPool();
    await upsertClientPolicy(app, clientId, "Live Allowed Client", ["env:dev", "env:live"]);
    // mia has no approved live grant in the seed data used by setupWebDb's personas.

    const res = await db.auth.api.mcpOAuthAuthorize({
      query: {
        client_id: clientId, response_type: "code",
        redirect_uri: "http://localhost:9999/callback", scope: "env:live openid",
        code_challenge: "test-challenge-000000000000000000000000000",
        code_challenge_method: "S256",
      },
      headers: { cookie: miaCookie } as any,
      asResponse: true,
    } as any);
    const location = res.headers.get("location") ?? "";
    const bodyText = await res.text().catch(() => "");
    expect(location + bodyText).not.toContain("env:live");
  });

  it("live-allowed client + user WITH an approved, unexpired live grant → env:live survives", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Live Allowed Client 2" },
      asResponse: true,
    } as any);
    const { clientId } = await reg.json();
    const app = getAppPool();
    await upsertClientPolicy(app, clientId, "Live Allowed Client 2", ["env:dev", "env:live"]);
    const grantId = await requestGrant(app, {
      userId: "mia", collection: "people", env: "live",
      purposeLabel: "test", allowedFields: ["id"],
    });
    await approveGrant(app, grantId, "marcus", { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });

    const res = await db.auth.api.mcpOAuthAuthorize({
      query: {
        client_id: clientId, response_type: "code",
        redirect_uri: "http://localhost:9999/callback", scope: "env:live",
        code_challenge: "test-challenge-000000000000000000000000000",
        code_challenge_method: "S256",
      },
      headers: { cookie: miaCookie } as any,
      asResponse: true,
    } as any);
    const location = res.headers.get("location") ?? "";
    const bodyText = await res.text().catch(() => "");
    expect(location + bodyText).toContain("env:live");
  });
});
```

- [ ] **Step 2: Run to verify the first assertion already passes (rule 1 covers it) and the second fails**

```bash
cd mvp && npx vitest run apps/web/test/oauth-scope.integration.test.ts
```

Expected: the "WITH an approved... live grant" test FAILS (rule 1 alone strips `env:live` for everyone, including eligible users — that's the bug rule 2 fixes by putting it back for eligible users. Wait — re-read: rule 1 only strips scopes the *client* isn't allowed; the client here is `env:live`-allowed, so rule 1 alone lets it through already. This test should currently PASS.) Run it and confirm both tests' actual pass/fail status matches this reasoning before proceeding; if the "WITH" test already passes, that's expected — rule 2 only needs to add the *ineligible-user* enforcement, which the first test (`NO approved live grant`) exercises and which currently FAILS since nothing checks grants yet.

- [ ] **Step 3: Implement rule 2**

In `mvp/apps/web/lib/oauth.ts`, update the import and the hook body:

```diff
-import { getClientPolicy } from "@warehousd/broker";
+import { getClientPolicy, hasApprovedLiveGrant } from "@warehousd/broker";
```

```diff
             const policy = await getClientPolicy(app, clientId);
-            const survivors = requestedEnv.filter((s) => policy.allowedScopes.includes(s));
+            let survivors = requestedEnv.filter((s) => policy.allowedScopes.includes(s));
+
+            if (survivors.includes("env:live")) {
+              const session = await getSessionFromCtx(ctx);
+              const userId = session?.user?.id;
+              const eligible = userId ? await hasApprovedLiveGrant(app, userId) : false;
+              if (!eligible) survivors = survivors.filter((s) => s !== "env:live");
+            }
```

- [ ] **Step 4: Run to verify both tests pass**

```bash
cd mvp && npx vitest run apps/web/test/oauth-scope.integration.test.ts
```

Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/oauth.ts apps/web/test/oauth-scope.integration.test.ts
git commit -m "feat(web): scope-issuance rule 2 — env:live requires an approved unexpired live grant"
```

---

## Task 6: Consent env-picker (rule 3 — exactly one env scope)

**Files:**
- Modify: `mvp/apps/web/lib/oauth.ts`
- Create: `mvp/apps/web/app/oauth/env-picker/page.tsx`
- Test: `mvp/apps/web/test/oauth-scope.integration.test.ts` (extend)

**Interfaces:**
- Produces: when both `env:dev` and `env:live` survive rules 1–2, the before-hook redirects to `/oauth/env-picker` instead of letting Better Auth's authorize handler proceed; resubmission carries a `wh_env` query param back to `/mcp/authorize`, at which point the hook collapses to a single scope. The **server**, not the picker UI, is what enforces exactly-one — a tampered `wh_env` value outside `{dev, live}` is ignored.

- [ ] **Step 1: Write the failing test**

Add to `mvp/apps/web/test/oauth-scope.integration.test.ts`:

```ts
describe("rule 3: both env:dev and env:live survive → redirected to the env picker", () => {
  it("redirects to /oauth/env-picker, carrying the surviving scopes", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Both Envs Client" },
      asResponse: true,
    } as any);
    const { clientId } = await reg.json();
    const app = getAppPool();
    await upsertClientPolicy(app, clientId, "Both Envs Client", ["env:dev", "env:live"]);
    const grantId = await requestGrant(app, {
      userId: "mia", collection: "people", env: "live", purposeLabel: "t", allowedFields: ["id"],
    });
    await approveGrant(app, grantId, "marcus", { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });

    const res = await db.auth.api.mcpOAuthAuthorize({
      query: {
        client_id: clientId, response_type: "code",
        redirect_uri: "http://localhost:9999/callback", scope: "env:dev env:live",
        code_challenge: "test-challenge-000000000000000000000000000",
        code_challenge_method: "S256",
      },
      headers: { cookie: miaCookie } as any,
      asResponse: true,
    } as any);
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain("/oauth/env-picker");
  });

  it("resubmitting with wh_env=live collapses to exactly one env scope", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Both Envs Client 2" },
      asResponse: true,
    } as any);
    const { clientId } = await reg.json();
    const app = getAppPool();
    await upsertClientPolicy(app, clientId, "Both Envs Client 2", ["env:dev", "env:live"]);
    const grantId = await requestGrant(app, {
      userId: "mia", collection: "people", env: "live", purposeLabel: "t", allowedFields: ["id"],
    });
    await approveGrant(app, grantId, "marcus", { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });

    const res = await db.auth.api.mcpOAuthAuthorize({
      query: {
        client_id: clientId, response_type: "code",
        redirect_uri: "http://localhost:9999/callback", scope: "env:dev env:live",
        wh_env: "live",
        code_challenge: "test-challenge-000000000000000000000000000",
        code_challenge_method: "S256",
      },
      headers: { cookie: miaCookie } as any,
      asResponse: true,
    } as any);
    const location = res.headers.get("location") ?? "";
    const bodyText = await res.text().catch(() => "");
    const combined = location + bodyText;
    expect(combined).toContain("env:live");
    expect(combined).not.toContain("env:dev");
  });

  it("a tampered wh_env value outside {dev,live} is ignored, re-triggering the picker redirect", async () => {
    const reg = await db.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Both Envs Client 3" },
      asResponse: true,
    } as any);
    const { clientId } = await reg.json();
    const app = getAppPool();
    await upsertClientPolicy(app, clientId, "Both Envs Client 3", ["env:dev", "env:live"]);
    const grantId = await requestGrant(app, {
      userId: "mia", collection: "people", env: "live", purposeLabel: "t", allowedFields: ["id"],
    });
    await approveGrant(app, grantId, "marcus", { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });

    const res = await db.auth.api.mcpOAuthAuthorize({
      query: {
        client_id: clientId, response_type: "code",
        redirect_uri: "http://localhost:9999/callback", scope: "env:dev env:live",
        wh_env: "env:live env:dev", // attempted injection
        code_challenge: "test-challenge-000000000000000000000000000",
        code_challenge_method: "S256",
      },
      headers: { cookie: miaCookie } as any,
      asResponse: true,
    } as any);
    expect(res.headers.get("location")).toContain("/oauth/env-picker");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd mvp && npx vitest run apps/web/test/oauth-scope.integration.test.ts
```

Expected: FAIL — both `env:dev` and `env:live` currently pass straight through to Better Auth's own authorize handler with no picker redirect.

- [ ] **Step 3: Implement rule 3 in the hook**

In `mvp/apps/web/lib/oauth.ts`:

```diff
             if (survivors.includes("env:live")) {
               const session = await getSessionFromCtx(ctx);
               const userId = session?.user?.id;
               const eligible = userId ? await hasApprovedLiveGrant(app, userId) : false;
               if (!eligible) survivors = survivors.filter((s) => s !== "env:live");
             }

+            if (survivors.includes("env:dev") && survivors.includes("env:live")) {
+              const picked = ctx.query?.wh_env;
+              if (picked === "dev" || picked === "live") {
+                survivors = [`env:${picked}`];
+              } else {
+                const params = new URLSearchParams(
+                  Object.entries(ctx.query ?? {}).map(([k, v]) => [k, String(v)]),
+                );
+                throw ctx.redirect(`/oauth/env-picker?${params.toString()}`);
+              }
+            }
+
             const others = requested.filter((s) => !(ENV_SCOPES as readonly string[]).includes(s));
             ctx.query = { ...ctx.query, scope: [...others, ...survivors].join(" ") };
```

- [ ] **Step 4: Build the picker page**

Create `mvp/apps/web/app/oauth/env-picker/page.tsx`:

```tsx
// Rule 3 (§6.1): shown only when BOTH env:dev and env:live survived rules 1-2 for this
// client+user. This radio is a hint — /mcp/authorize's before-hook re-derives eligibility
// on resubmit and ignores any wh_env value outside {dev, live}. Default selection is dev.
export default function EnvPickerPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const params = new URLSearchParams(
    Object.entries(searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] ?? "" : v ?? ""]),
  );
  const authorizeAction = `/api/auth/mcp/authorize?${params.toString()}`;

  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "system-ui" }}>
      <h1>Choose an environment</h1>
      <p>This app is requesting access. Pick which data environment to connect it to.</p>
      <form action={authorizeAction} method="GET">
        {Array.from(params.entries()).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <label style={{ display: "block", marginBottom: 8 }}>
          <input type="radio" name="wh_env" value="dev" defaultChecked /> Development (synthetic data)
        </label>
        <label style={{ display: "block", marginBottom: 16 }}>
          <input type="radio" name="wh_env" value="live" /> Live (real data)
        </label>
        <button type="submit">Continue</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
cd mvp && npx vitest run apps/web/test/oauth-scope.integration.test.ts
```

Expected: PASS (all tests, including the earlier rule 1/2 tests — check for regressions since the redirect branch is new code in the same function).

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/oauth.ts apps/web/app/oauth/env-picker/page.tsx apps/web/test/oauth-scope.integration.test.ts
git commit -m "feat(web): scope-issuance rule 3 — server-enforced env picker for dual-eligible requests"
```

---

## Task 7: Refresh re-evaluation (rule 4)

**Files:**
- Modify: `mvp/apps/web/lib/oauth.ts`
- Test: `mvp/apps/web/test/oauth-refresh.integration.test.ts`

**Interfaces:**
- Consumes: `getClientPolicy`, `hasApprovedLiveGrant`, `setAllowedScopes` from `@warehousd/broker`.
- Produces: an `after` hook on `/mcp/token` (refresh_token grant only) added to the same `envScopePlugin`, correcting both the persisted `oauthAccessToken.scopes` row and the JSON response before it reaches the client.

- [ ] **Step 1: Write the failing test**

Create `mvp/apps/web/test/oauth-refresh.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { upsertClientPolicy, setAllowedScopes, requestGrant, approveGrant, revokeGrant } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let miaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("oauthrefresh");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

// Drives a client all the way from DCR through authorize+consent to get a real refresh_token,
// since /mcp/token's refresh path needs a genuine row in oauthAccessToken to correct.
async function issueTokenWithLiveScope() {
  const app = getAppPool();
  const reg = await db.auth.api.registerMcpClient({
    body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Refresh Test Client" },
    asResponse: true,
  } as any);
  const { clientId, clientSecret } = await reg.json();
  await upsertClientPolicy(app, clientId, "Refresh Test Client", ["env:dev", "env:live"]);
  const grantId = await requestGrant(app, {
    userId: "mia", collection: "people", env: "live", purposeLabel: "t", allowedFields: ["id"],
  });
  await approveGrant(app, grantId, "marcus", { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });

  const authRes = await db.auth.api.mcpOAuthAuthorize({
    query: {
      client_id: clientId, response_type: "code",
      redirect_uri: "http://localhost:9999/callback", scope: "env:live",
      code_challenge: "test-challenge-000000000000000000000000000",
      code_challenge_method: "S256",
    },
    headers: { cookie: miaCookie } as any,
    asResponse: true,
  } as any);
  // Better Auth's default consent page requires an explicit accept for a first-time client;
  // extract the consent_code Better Auth redirected to and accept it as mia.
  const location = authRes.headers.get("location") ?? "";
  const consentCode = new URL(location, "http://localhost").searchParams.get("consent_code");
  const consentRes = await db.auth.api.oAuthConsent({
    body: { accept: true, consent_code: consentCode },
    headers: { cookie: miaCookie } as any,
    asResponse: true,
  } as any);
  const { redirectURI } = await consentRes.json();
  const code = new URL(redirectURI).searchParams.get("code");

  const tokenRes = await db.auth.api.mcpOAuthToken({
    body: {
      grant_type: "authorization_code", code, redirect_uri: "http://localhost:9999/callback",
      client_id: clientId, client_secret: clientSecret,
      code_verifier: "test-challenge-000000000000000000000000000",
    },
    asResponse: true,
  } as any);
  const tokenBody = await tokenRes.json();
  return { clientId, clientSecret, ...tokenBody };
}

describe("rule 4: scope rules re-run on every refresh", () => {
  it("demotion takes effect on the next refresh", async () => {
    const { clientId, clientSecret, refresh_token } = await issueTokenWithLiveScope();
    const app = getAppPool();
    await setAllowedScopes(app, clientId, ["env:dev"], "ana"); // demote

    const res = await db.auth.api.mcpOAuthToken({
      body: { grant_type: "refresh_token", refresh_token, client_id: clientId, client_secret: clientSecret },
      asResponse: true,
    } as any);
    const body = await res.json();
    expect(body.scope).not.toContain("env:live");
  });

  it("revoked live grant takes effect on the next refresh", async () => {
    const app = getAppPool();
    const { clientId, clientSecret, refresh_token } = await issueTokenWithLiveScope();
    const g = await app.query(`select id from app.grants where user_id='mia' and env='live' and status='approved' order by requested_at desc limit 1`);
    await revokeGrant(app, g.rows[0].id, "marcus");

    const res = await db.auth.api.mcpOAuthToken({
      body: { grant_type: "refresh_token", refresh_token, client_id: clientId, client_secret: clientSecret },
      asResponse: true,
    } as any);
    const body = await res.json();
    expect(body.scope).not.toContain("env:live");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd mvp && npx vitest run apps/web/test/oauth-refresh.integration.test.ts
```

Expected: FAIL — `body.scope` still contains `env:live` in both cases (Better Auth's native refresh handler copies the old token's scopes verbatim).

- [ ] **Step 3: Implement the after-hook**

In `mvp/apps/web/lib/oauth.ts`, add an `after` array to `envScopePlugin`'s returned `hooks` object:

```diff
     hooks: {
       before: [ /* ...unchanged... */ ],
+      after: [
+        {
+          matcher: (ctx: { path: string }) => ctx.path === "/mcp/token",
+          handler: createAuthMiddleware(async (ctx: any) => {
+            const grantType = ctx.body?.grant_type;
+            if (grantType !== "refresh_token") return;
+            const returned = ctx.context.returned as { access_token?: string; scope?: string } | undefined;
+            if (!returned?.access_token) return;
+
+            const row = await ctx.context.adapter.findOne({
+              model: "oauthAccessToken",
+              where: [{ field: "accessToken", value: returned.access_token }],
+            });
+            if (!row) return;
+
+            const current: string[] = String(row.scopes ?? "").split(" ").filter(Boolean);
+            const currentEnv = current.filter((s) => (ENV_SCOPES as readonly string[]).includes(s));
+            if (currentEnv.length === 0) return;
+
+            const policy = await getClientPolicy(app, row.clientId);
+            let allowed = currentEnv.filter((s) => policy.allowedScopes.includes(s));
+            if (allowed.includes("env:live")) {
+              const eligible = await hasApprovedLiveGrant(app, row.userId);
+              if (!eligible) allowed = allowed.filter((s) => s !== "env:live");
+            }
+
+            const recomputed = [...current.filter((s) => !(ENV_SCOPES as readonly string[]).includes(s)), ...allowed].join(" ");
+            if (recomputed === row.scopes) return;
+
+            await ctx.context.adapter.update({
+              model: "oauthAccessToken",
+              where: [{ field: "accessToken", value: returned.access_token }],
+              update: { scopes: recomputed },
+            });
+            ctx.context.returned = { ...returned, scope: recomputed };
+          }),
+        },
+      ],
     },
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd mvp && npx vitest run apps/web/test/oauth-refresh.integration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Re-run the full oauth-scope suite for regressions**

```bash
cd mvp && npx vitest run apps/web/test/oauth-scope.integration.test.ts apps/web/test/oauth.integration.test.ts
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/oauth.ts apps/web/test/oauth-refresh.integration.test.ts
git commit -m "feat(web): scope-issuance rule 4 — re-run policy/grant checks on every token refresh"
```

---

## Task 8: Dynamic client registration bootstraps `{env:dev, env:live}`

**Files:**
- Modify: `mvp/apps/web/lib/oauth.ts`
- Test: `mvp/apps/web/test/oauth-dcr.integration.test.ts`

**Interfaces:**
- Consumes: `upsertClientPolicy` from `@warehousd/broker`.
- Produces: an `after` hook on `/mcp/register` inserting the DCR-default `client_policies` row for every dynamically registered client, so that rule 1 (Task 4) has a policy row to intersect against instead of falling back to the missing-row default (`{env:dev}`) for clients that are *supposed* to start with both scopes.

- [ ] **Step 1: Write the failing test**

Create `mvp/apps/web/test/oauth-dcr.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb } from "./helpers/web-db";
import { getClientPolicy } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
beforeAll(async () => { db = await setupWebDb("oauthdcr"); }, 60_000);
afterAll(async () => { await db?.end(); });

it("a dynamically registered client gets allowed_scopes = {env:dev, env:live} at registration", async () => {
  const res = await db.auth.api.registerMcpClient({
    body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "DCR Client" },
    asResponse: true,
  } as any);
  const { clientId } = await res.json();
  const policy = await getClientPolicy(getAppPool(), clientId);
  expect(policy.allowedScopes.sort()).toEqual(["env:dev", "env:live"]);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd mvp && npx vitest run apps/web/test/oauth-dcr.integration.test.ts
```

Expected: FAIL — no policy row is created on registration yet, so `getClientPolicy` falls back to `{env:dev}` only.

- [ ] **Step 3: Implement**

In `mvp/apps/web/lib/oauth.ts`, add another entry to the `after` array (alongside the `/mcp/token` refresh hook from Task 7):

```diff
+import { getClientPolicy, hasApprovedLiveGrant, upsertClientPolicy } from "@warehousd/broker";
```

```diff
       after: [
         { matcher: (ctx) => ctx.path === "/mcp/token", handler: /* ...Task 7... */ },
+        {
+          matcher: (ctx: { path: string }) => ctx.path === "/mcp/register",
+          handler: createAuthMiddleware(async (ctx: any) => {
+            const returned = ctx.context.returned as { clientId?: string; name?: string } | undefined;
+            if (!returned?.clientId) return;
+            await upsertClientPolicy(app, returned.clientId, returned.name ?? null, ["env:dev", "env:live"]);
+          }),
+        },
       ],
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd mvp && npx vitest run apps/web/test/oauth-dcr.integration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/oauth.ts apps/web/test/oauth-dcr.integration.test.ts
git commit -m "feat(web): DCR clients bootstrap client_policies with {env:dev,env:live}"
```

---

## Task 9: Manual client creation + promotion/demotion API

**Files:**
- Create: `mvp/apps/web/app/api/oauth-clients/route.ts`
- Create: `mvp/apps/web/app/api/oauth-clients/[clientId]/promote/route.ts`
- Test: `mvp/apps/web/test/oauth-clients.integration.test.ts`

**Interfaces:**
- Produces: `POST /api/oauth-clients` (any authenticated user may create — matches "User-built apps" in §6.1; returns `{ clientId, clientSecret }`; always bootstraps `{env:dev}`), `POST /api/oauth-clients/:clientId/promote` and the demote counterpart via `{ action: "promote" | "demote" }` in the body (manager/admin only, same 403 pattern as `app/api/grants/route.ts`).
- Consumes: `auth.api.createOAuthClient` (or the equivalent Better Auth admin client-creation call — confirm the exact method name against the installed version in Step 1 below; the `oidc-provider` plugin's client schema is what backs it), `setAllowedScopes`, `upsertClientPolicy`, `getSessionUser` from `../../../lib/session`.

- [ ] **Step 1: Confirm the manual-creation API surface**

The `mcp`/`oidc-provider` plugin doesn't expose a public "admin creates a client" REST endpoint in its own `endpoints` map (`registerMcpClient` is DCR, self-service by the client). Check whether `better-auth/plugins/oidc-provider` (or the `oauthApplication` model) offers a server-side helper:

```bash
node -e "import('better-auth/plugins').then(m => console.log(Object.keys(m).filter(k => /client/i.test(k))))"
```

If no such helper exists, the plan's fallback (write directly to `app."oauthApplication"` via the same `Pool` used elsewhere, generating `clientId`/`clientSecret` with `crypto.randomBytes`) is what Step 3 below implements — this matches the outline's note that "a minimal creation path (data layer or Better Auth client API)" is acceptable for Phase 2, with the Admin UI itself deferred to Phase 5.

- [ ] **Step 2: Write the failing test**

Create `mvp/apps/web/test/oauth-clients.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { getClientPolicy } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let miaCookie: string, marcusCookie: string;

beforeAll(async () => {
  db = await setupWebDb("oauthclients");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

function req(url: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  return new Request(`http://localhost:8722${url}`, {
    method: opts.method ?? "GET", headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

describe("manual client creation", () => {
  it("member can create a client; it always starts with {env:dev} — no override", async () => {
    const { POST } = await import("../app/api/oauth-clients/route");
    const res = await POST(req("/api/oauth-clients", {
      method: "POST", cookie: miaCookie,
      body: { name: "My Reporting App", allowedScopes: ["env:dev", "env:live"] }, // attempted override
    }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clientId).toBeTruthy();
    expect(body.clientSecret).toBeTruthy();
    const policy = await getClientPolicy(getAppPool(), body.clientId);
    expect(policy.allowedScopes).toEqual(["env:dev"]);
  });
});

describe("promotion/demotion", () => {
  it("member cannot promote → 403", async () => {
    const { POST: createClient } = await import("../app/api/oauth-clients/route");
    const created = await (await createClient(req("/api/oauth-clients", {
      method: "POST", cookie: miaCookie, body: { name: "App" },
    }) as any)).json();

    const { POST } = await import("../app/api/oauth-clients/[clientId]/promote/route");
    const res = await POST(req(`/api/oauth-clients/${created.clientId}/promote`, {
      method: "POST", cookie: miaCookie, body: { action: "promote" },
    }) as any, { params: Promise.resolve({ clientId: created.clientId }) });
    expect(res.status).toBe(403);
  });

  it("manager can promote, stamping promoted_by; and demote", async () => {
    const { POST: createClient } = await import("../app/api/oauth-clients/route");
    const created = await (await createClient(req("/api/oauth-clients", {
      method: "POST", cookie: miaCookie, body: { name: "App" },
    }) as any)).json();

    const { POST } = await import("../app/api/oauth-clients/[clientId]/promote/route");
    const promoteRes = await POST(req(`/api/oauth-clients/${created.clientId}/promote`, {
      method: "POST", cookie: marcusCookie, body: { action: "promote" },
    }) as any, { params: Promise.resolve({ clientId: created.clientId }) });
    expect(promoteRes.status).toBe(200);
    let policy = await getClientPolicy(getAppPool(), created.clientId);
    expect(policy.allowedScopes.sort()).toEqual(["env:dev", "env:live"]);

    const demoteRes = await POST(req(`/api/oauth-clients/${created.clientId}/promote`, {
      method: "POST", cookie: marcusCookie, body: { action: "demote" },
    }) as any, { params: Promise.resolve({ clientId: created.clientId }) });
    expect(demoteRes.status).toBe(200);
    policy = await getClientPolicy(getAppPool(), created.clientId);
    expect(policy.allowedScopes).toEqual(["env:dev"]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd mvp && npx vitest run apps/web/test/oauth-clients.integration.test.ts
```

Expected: FAIL — `Cannot find module '../app/api/oauth-clients/route'`.

- [ ] **Step 4: Implement `POST /api/oauth-clients`**

Create `mvp/apps/web/app/api/oauth-clients/route.ts`:

```ts
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { getAppPool } from "../../lib/broker";
import { upsertClientPolicy } from "@warehousd/broker";
import { getSessionUser } from "../../../lib/session";

// Manually created clients (§6.1 "User-built apps") always start at {env:dev} — no
// creation-time override, regardless of what the request body asks for. Promotion is a
// separate, manager/admin-only step (see [clientId]/promote/route.ts).
export async function POST(req: NextRequest) {
  const sessionUser = await getSessionUser(req);
  if (!sessionUser) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { name } = await req.json();

  const clientId = randomBytes(16).toString("hex");
  const clientSecret = randomBytes(32).toString("hex");
  const app = getAppPool();
  await app.query(
    `insert into app."oauthApplication" ("clientId","clientSecret",name,type,"redirectURLs","userId","createdAt","updatedAt")
     values ($1,$2,$3,'web','[]',$4,now(),now())`,
    [clientId, clientSecret, name ?? "Untitled client", sessionUser.id]);
  await upsertClientPolicy(app, clientId, name ?? null, ["env:dev"]);

  return Response.json({ clientId, clientSecret });
}
```

Note: the exact `oauthApplication` column names (`"redirectURLs"` vs `redirectUrls`, `name` casing, `type` values) must match whatever Task 1 Step 1's `information_schema.tables` / `information_schema.columns` discovery found — re-run `select column_name from information_schema.columns where table_schema='app' and table_name='oauthApplication'` against a migrated test DB and adjust this INSERT before running Step 5. This is exactly the kind of drift the outline's expansion notes warned about.

- [ ] **Step 5: Implement `POST /api/oauth-clients/:clientId/promote`**

Create `mvp/apps/web/app/api/oauth-clients/[clientId]/promote/route.ts`:

```ts
import { NextRequest } from "next/server";
import { getAppPool } from "../../../../lib/broker";
import { setAllowedScopes } from "@warehousd/broker";
import { getSessionUser } from "../../../../../lib/session";

export async function POST(req: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const sessionUser = await getSessionUser(req);
  if (!sessionUser) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (sessionUser.role !== "manager" && sessionUser.role !== "admin") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const { clientId } = await params;
  const { action } = await req.json();
  const scopes = action === "promote" ? ["env:dev", "env:live"] : ["env:dev"];
  await setAllowedScopes(getAppPool(), clientId, scopes, sessionUser.id);
  return Response.json({ ok: true });
}
```

- [ ] **Step 6: Run to verify it passes**

```bash
cd mvp && npx vitest run apps/web/test/oauth-clients.integration.test.ts
```

Expected: PASS. If the INSERT in Step 4 errors on column names, fix per the Step 4 note and re-run.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/api/oauth-clients apps/web/test/oauth-clients.integration.test.ts
git commit -m "feat(web): manual OAuth client creation ({env:dev} only) + manager/admin promote/demote API"
```

---

## Task 10: `broker-context.ts` — token-path `BrokerContext` constructor

**Files:**
- Create: `mvp/apps/web/lib/broker-context.ts`
- Modify: `mvp/apps/web/lib/session.ts` (comment update — two-constructor invariant)
- Test: `mvp/apps/web/test/broker-context.test.ts`

**Interfaces:**
- Produces: `deriveTokenContext(req: Request): Promise<BrokerContext | null>` — the sole constructor of `BrokerContext` for token (MCP/OAuth) paths, mirroring `deriveContext` in `session.ts` for cookie paths.
- Consumes: `auth.api.getMcpSession` (returns `OAuthAccessToken | null`, verifying signature/expiry and reading `scopes`, `userId`).

- [ ] **Step 1: Write the failing test**

Create `mvp/apps/web/test/broker-context.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { upsertClientPolicy, requestGrant, approveGrant } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let miaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("brokerctx");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

async function mintAccessToken(scope: string) {
  const app = getAppPool();
  const reg = await db.auth.api.registerMcpClient({
    body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "BC Client" },
    asResponse: true,
  } as any);
  const { clientId, clientSecret } = await reg.json();
  await upsertClientPolicy(app, clientId, "BC Client", ["env:dev", "env:live"]);
  if (scope.includes("env:live")) {
    const g = await requestGrant(app, { userId: "mia", collection: "people", env: "live", purposeLabel: "t", allowedFields: ["id"] });
    await approveGrant(app, g, "marcus", { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  }
  const authRes = await db.auth.api.mcpOAuthAuthorize({
    query: {
      client_id: clientId, response_type: "code", redirect_uri: "http://localhost:9999/callback",
      scope, code_challenge: "test-challenge-000000000000000000000000000", code_challenge_method: "S256",
    },
    headers: { cookie: miaCookie } as any, asResponse: true,
  } as any);
  const location = authRes.headers.get("location") ?? "";
  const consentCode = new URL(location, "http://localhost").searchParams.get("consent_code");
  const consentRes = await db.auth.api.oAuthConsent({
    body: { accept: true, consent_code: consentCode }, headers: { cookie: miaCookie } as any, asResponse: true,
  } as any);
  const { redirectURI } = await consentRes.json();
  const code = new URL(redirectURI).searchParams.get("code");
  const tokenRes = await db.auth.api.mcpOAuthToken({
    body: {
      grant_type: "authorization_code", code, redirect_uri: "http://localhost:9999/callback",
      client_id: clientId, client_secret: clientSecret,
      code_verifier: "test-challenge-000000000000000000000000000",
    },
    asResponse: true,
  } as any);
  return (await tokenRes.json()).access_token as string;
}

describe("deriveTokenContext", () => {
  it("env:live token → ctx.env='live', ctx.userId=token subject", async () => {
    const { deriveTokenContext } = await import("../lib/broker-context");
    const token = await mintAccessToken("env:live");
    const ctx = await deriveTokenContext(new Request("http://localhost:8722/mcp", {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(ctx).toEqual({ userId: "mia", env: "live" });
  });

  it("token with no env scope → adapter resolves dev", async () => {
    const { deriveTokenContext } = await import("../lib/broker-context");
    const token = await mintAccessToken("openid");
    const ctx = await deriveTokenContext(new Request("http://localhost:8722/mcp", {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(ctx).toEqual({ userId: "mia", env: "dev" });
  });

  it("invalid/missing token → null", async () => {
    const { deriveTokenContext } = await import("../lib/broker-context");
    const ctx = await deriveTokenContext(new Request("http://localhost:8722/mcp", {
      headers: { authorization: "Bearer not-a-real-token" },
    }));
    expect(ctx).toBeNull();
  });

  it("an env-like body param is never read — only the verified token's scopes matter", async () => {
    const { deriveTokenContext } = await import("../lib/broker-context");
    const token = await mintAccessToken("env:dev");
    const ctx = await deriveTokenContext(new Request("http://localhost:8722/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ env: "live" }),
    }));
    expect(ctx?.env).toBe("dev");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd mvp && npx vitest run apps/web/test/broker-context.test.ts
```

Expected: FAIL — `Cannot find module '../lib/broker-context'`.

- [ ] **Step 3: Implement**

Create `mvp/apps/web/lib/broker-context.ts`:

```ts
import type { BrokerContext } from "@warehousd/broker";
import { auth } from "./auth";

// The ONLY place BrokerContext is constructed for token-authenticated (MCP/OAuth) paths.
// lib/session.ts's deriveContext remains the sole constructor for cookie/session paths — see
// the note there. Tokens carry only sub/client/env scope (§6.1); any env-like value in the
// request body/params is ignored and never read here.
export async function deriveTokenContext(req: Request): Promise<BrokerContext | null> {
  const session = await auth.api.getMcpSession({ headers: req.headers });
  if (!session) return null;
  const scopes = (session.scopes ?? "").split(" ").filter(Boolean);
  const env = scopes.includes("env:live") ? "live" : "dev";
  return { userId: session.userId, env };
}
```

- [ ] **Step 4: Update `session.ts`'s comment for the two-constructor invariant**

```diff
-// The ONLY place BrokerContext is constructed in the web console. userId comes from the
-// verified session; env from the env cookie. Any env-like body param is ignored.
+// The sole BrokerContext constructor for cookie/session (web console) paths. userId comes
+// from the verified session; env from the env cookie. Any env-like body param is ignored.
+// Token-authenticated (MCP/OAuth) paths use lib/broker-context.ts's deriveTokenContext
+// instead — two constructors, one per auth path, never a third.
```

- [ ] **Step 5: Run to verify it passes**

```bash
cd mvp && npx vitest run apps/web/test/broker-context.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/broker-context.ts apps/web/lib/session.ts apps/web/test/broker-context.test.ts
git commit -m "feat(web): broker-context.ts — sole BrokerContext constructor for token paths"
```

---

## Task 11: Acceptance gate — extend §10 test 5

**Files:**
- Modify: `mvp/packages/broker/test/db-roles.test.ts`

**Interfaces:**
- Consumes: everything above. This task adds no new production code — it is the acceptance-gate checklist from the outline, turned into assertions that sit alongside (not duplicate) the existing "test 5 (partial)".

- [ ] **Step 1: Write the additional acceptance assertions**

The existing "test 5 (partial)" in `mvp/packages/broker/test/db-roles.test.ts` covers the data-wall half (dev sees no live canary; `warehousd_dev` refused on `data_live`). Add a new, separate `it` block in the same file — do not touch the existing one — covering the token/scope half. Since this file's `beforeAll` doesn't spin up the web app's `betterAuth()` instance, this new block should call into `apps/web`'s test helpers directly:

```ts
import { setupWebDb, signIn } from "../../../apps/web/test/helpers/web-db";
import { upsertClientPolicy, requestGrant, approveGrant, revokeGrant } from "../src";

it("test 5 (scope clauses): full env-as-scope acceptance gate", async () => {
  const web = await setupWebDb("acceptance5");
  try {
    const miaCookie = await signIn(web.auth, "mia@meridian.demo", "demo");
    const app = (await import("../../../apps/web/app/lib/broker")).getAppPool();

    // Dev-only client requesting env:live → issued token contains only env:dev.
    const reg = await web.auth.api.registerMcpClient({
      body: { redirect_uris: ["http://localhost:9999/callback"], client_name: "Acceptance Client" },
      asResponse: true,
    } as any);
    const { clientId, clientSecret } = await reg.json();
    await upsertClientPolicy(app, clientId, "Acceptance Client", ["env:dev"]); // dev-only

    async function authorizeAndGetToken(scope: string) {
      const authRes = await web.auth.api.mcpOAuthAuthorize({
        query: {
          client_id: clientId, response_type: "code", redirect_uri: "http://localhost:9999/callback",
          scope, code_challenge: "test-challenge-000000000000000000000000000", code_challenge_method: "S256",
        },
        headers: { cookie: miaCookie } as any, asResponse: true,
      } as any);
      const location = authRes.headers.get("location") ?? "";
      const consentCode = new URL(location, "http://localhost").searchParams.get("consent_code");
      const consentRes = await web.auth.api.oAuthConsent({
        body: { accept: true, consent_code: consentCode }, headers: { cookie: miaCookie } as any, asResponse: true,
      } as any);
      const { redirectURI } = await consentRes.json();
      const code = new URL(redirectURI).searchParams.get("code");
      const tokenRes = await web.auth.api.mcpOAuthToken({
        body: {
          grant_type: "authorization_code", code, redirect_uri: "http://localhost:9999/callback",
          client_id: clientId, client_secret: clientSecret,
          code_verifier: "test-challenge-000000000000000000000000000",
        },
        asResponse: true,
      } as any);
      return tokenRes.json();
    }

    const t1 = await authorizeAndGetToken("env:live");
    expect(t1.scope).not.toContain("env:live");
    expect(t1.scope).toContain("env:dev");

    // After promotion, next refresh yields env:live.
    const { setAllowedScopes } = await import("../src");
    await setAllowedScopes(app, clientId, ["env:dev", "env:live"], "ana");
    const grantId = await requestGrant(app, { userId: "mia", collection: "people", env: "live", purposeLabel: "t", allowedFields: ["id"] });
    await approveGrant(app, grantId, "marcus", { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    const refreshed = await web.auth.api.mcpOAuthToken({
      body: { grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: clientId, client_secret: clientSecret },
      asResponse: true,
    } as any).then((r: Response) => r.json());
    expect(refreshed.scope).toContain("env:live");

    // After demotion, next refresh drops it.
    await setAllowedScopes(app, clientId, ["env:dev"], "ana");
    const demoted = await web.auth.api.mcpOAuthToken({
      body: { grant_type: "refresh_token", refresh_token: refreshed.refresh_token, client_id: clientId, client_secret: clientSecret },
      asResponse: true,
    } as any).then((r: Response) => r.json());
    expect(demoted.scope).not.toContain("env:live");

    // Token with no env scope → adapter defaults to dev.
    await setAllowedScopes(app, clientId, ["env:dev", "env:live"], "ana");
    const noEnv = await authorizeAndGetToken("openid");
    const { deriveTokenContext } = await import("../../../apps/web/lib/broker-context");
    const ctx = await deriveTokenContext(new Request("http://localhost:8722/mcp", {
      headers: { authorization: `Bearer ${noEnv.access_token}` },
    }));
    expect(ctx?.env).toBe("dev");

    // Token payload contains only sub/client/env — no grant data (spot-check the row).
    const row = await app.query(`select * from app."oauthAccessToken" where "accessToken"=$1`, [noEnv.access_token]);
    const cols = Object.keys(row.rows[0]);
    expect(cols).not.toEqual(expect.arrayContaining(["allowedFields", "purposeLabel", "documentFilter"]));

    // Revoked grant → env:live gone within one forced refresh.
    const liveToken = await authorizeAndGetToken("env:live");
    const g2 = await app.query(`select id from app.grants where user_id='mia' and env='live' and status='approved' order by requested_at desc limit 1`);
    await revokeGrant(app, g2.rows[0].id, "marcus");
    const afterRevoke = await web.auth.api.mcpOAuthToken({
      body: { grant_type: "refresh_token", refresh_token: liveToken.refresh_token, client_id: clientId, client_secret: clientSecret },
      asResponse: true,
    } as any).then((r: Response) => r.json());
    expect(afterRevoke.scope).not.toContain("env:live");
  } finally {
    await web.end();
  }
}, 60_000);
```

- [ ] **Step 2: Run to verify it fails first (in case any wiring above has a gap)**

```bash
cd mvp && npx vitest run packages/broker/test/db-roles.test.ts
```

Run this BEFORE any of Tasks 4–10 are complete to confirm it fails for the right reasons if you're validating incrementally; once all prior tasks are done it should already pass on the first run — treat an unexpected failure here as a signal that an earlier task's hook has a gap, and go back to fix that task rather than special-casing this test.

- [ ] **Step 3: Run to verify it passes**

```bash
cd mvp && pnpm test
```

Expected: full suite green, including the pre-existing "test 5 (partial)" (untouched) and every test file from Tasks 0–11.

- [ ] **Step 4: Commit**

```bash
git add packages/broker/test/db-roles.test.ts
git commit -m "test: extend acceptance gate test 5 with the full env-as-scope token/refresh clauses"
```

---

## Post-plan checklist (do not skip)

- [ ] Confirm every originally-flagged expansion concern was addressed by a task above (version bump → Task 0; two-constructor invariant → Task 10; NULL `expires_at` → Task 3; consent picker → Task 6; `client_policies` write location/idempotency/FK → Tasks 1–2; DCR + manual-client + missing-policy-row semantics → Tasks 8–9).
