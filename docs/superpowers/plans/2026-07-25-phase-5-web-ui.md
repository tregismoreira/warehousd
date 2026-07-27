# Phase 5 — Admin / Manager / Member Web UI Implementation Plan

> **Destination:** after approval, copy this file to `docs/superpowers/plans/2026-07-25-phase-5-web-ui.md` (house convention) and replace the outline at `docs/superpowers/plans/2026-07-20-phase-5-web-ui.md` with a pointer to it.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Invoke `building-product-ui` before writing any component, and `superpowers:test-driven-development` for every task with a test.

---

## Context

Today `mvp/apps/web` is still the Phase 0 POC shape: a single screen at `/` with three inline-styled columns (Chat | Evidence | Grants), a login page, and nine API routes. Phases 1–4 built the whole enforcement and identity spine underneath it — roles, OAuth 2.1 with env-as-scope, `/mcp`, SSO — but none of that has a surface. There is no navigation, no admin anything, no way to see a collection's postures, no client list, no user-role management, and no way for real data to enter `data_live` at all.

Phase 5 replaces the single POC screen with three role-scoped surfaces (SPECS §8) and adds the one missing backend capability the spec assumes exists: the admin import path (§11 step 3 — *"deploy never writes `data_live`; real data arrives via the admin import path"*). This is also the demo stage, so it gets a real design system rather than more inline styles.

Two live defects found during planning are fixed here because they sit exactly on the Manager surface being rebuilt:

1. `app/api/grants/route.ts:47` sets `opts.rowFilter`, but `approveGrant` reads `opts.documentFilter` — **every path-scoped approval made through the UI silently grants unrestricted access.** The `selectedTerms` the client sends is never read at all, so taxonomy-scoped approvals are equally dead.
2. `app/api/grants/route.ts:33` has an `action === "request"` branch that does nothing — members cannot request access from the web UI at all, only through the MCP `request_access` tool.

**Outcome:** `/admin`, `/manager`, `/member` surfaces behind server-side role guards; the chat console demoted to a dev-only `/console`; `data_live` reachable through one audited, validated, INSERT-only import path; §10 test 7 driven end-to-end through the real routes and through a real browser.

---

## Branch dependency (read before Task 0)

**Phase 4 (SSO) is complete but NOT merged to `main`.** It lives on branch `phase-4-sso` (worktree `/Users/tregis/conductor/workspaces/warehousd-v1/wellington`, HEAD `28b5be6`). This branch (`phase-5-web-ui`) is at `1b1bf9d` = Phase 3.

Phase 4 changes things this plan depends on:

| Change | Detail |
|---|---|
| Kill-switch env var renamed | `SANDBOXD_DISABLE_LOCAL_LOGIN` → **`WAREHOUSD_DISABLE_LOCAL_LOGIN`** |
| New SSO admin API | `GET/POST /api/sso/providers`, `DELETE /api/sso/providers/[providerId]`, `GET /api/sso/status` (all already admin-gated) |
| New deps | `@better-auth/sso@^1.6.25`, `better-auth` bumped to `^1.6.25`, `pg` added to web deps |
| `lib/auth.ts` | gains `ssoPlugin(appPool)`, `ssoAdminPlugin()`, `trustedOrigins()` |
| `lib/sso.ts` | new — JIT provisioning + admin gate on Better Auth's own `/sso/*` endpoints |
| `middleware.ts` | matcher extended with `/api/sso/providers` and `/api/sso/providers/:path*` |
| `app/login/page.tsx` | rewritten with SSO provider buttons + `returnTo` OAuth continuation |
| `test/helpers/web-db.ts` | extended (fake IdP helpers, `test/helpers/sso.ts`, `test/helpers/fake-idp.ts`) |
| `docker-compose.test.yml` | gains a Keycloak service |

Task 0 merges it. **Do not start any other task until Task 0 is green.**

---

**Goal:** Replace the single POC console with role-scoped Admin / Manager / Member surfaces on a real design system, and add the audited, schema-validated, INSERT-only admin import path that is the only way real data enters `data_live`.

**Architecture:** Next.js App Router with three real URL segments (`/admin`, `/manager`, `/member`) — not route groups, because the §11 outputs contract pins `adminUrl` to `http://localhost:8722/admin`. Each segment's `layout.tsx` is an async server component that reads the Better Auth session and `redirect()`s on the wrong role; every API route repeats the check server-side through one shared `requireRole()` helper (the layout guard is UX, the route guard is enforcement). UI is Tailwind v4 + shadcn/ui on a dark neutral "security console" theme. The import path adds a fourth Postgres role, `warehousd_import`, with `INSERT` and nothing else on `data_live` base tables, mirroring the two-role dev/live wall — validation and audit live in `packages/broker/src/import/`, keeping the broker the only thing that touches data schemas.

**Tech Stack:** Next.js 15 / React 19, Tailwind CSS v4 (`@tailwindcss/postcss`), shadcn/ui + Radix, lucide-react, TanStack Table v8, react-hook-form + zod v4 + `@hookform/resolvers`, sonner, Better Auth 1.6.25 (+ `@better-auth/sso`), `pg`, Vitest 2.1 (route-handler integration tests), Playwright 1.62 (browser e2e).

---

## Design language

"Conductor-style" here means the **Linear / Vercel / Supabase family**, which is also what `building-product-ui` prescribes: a neutral near-black canvas, hairline borders instead of shadows, a compact sidebar-driven workspace shell, dense-but-airy tables, one restrained accent, and monospace for every technical value (ids, intents, paths, scopes, timestamps).

Non-negotiable carry-overs from the Phase 0 console (SPECS §14):

- **Evidence prominence.** The audit browser is a first-class surface, not a footnote.
- **Monospace for intents and audit rows.** `font-mono` on every id, collection name, field list, scope, and JSON intent.
- **Allow/deny semantics beyond red/green alone.** Every outcome badge carries a glyph (`✓` / `✗`) *and* a label, never colour alone. The existing `.allow::before` / `.deny::before` CSS rules are replaced by a `<OutcomeBadge>` component that keeps both signals.

Palette mapping — the existing seven CSS vars become the shadcn token set so nothing regresses:

| Existing var | shadcn token | Value |
|---|---|---|
| `--bg` `#0d1117` | `--background` | `#0d1117` |
| `--panel` `#161b22` | `--card`, `--popover` | `#161b22` |
| `--fg` `#e6edf3` | `--foreground` | `#e6edf3` |
| `--muted` `#8b949e` | `--muted-foreground` | `#8b949e` |
| `#30363d` (inline) | `--border`, `--input` | `#30363d` |
| `--allow` `#2ea043` | `--allow` (custom) | `#2ea043` |
| `--deny` `#d1242f` | `--destructive`, `--deny` | `#d1242f` |
| `--mono` | `--font-mono` | `"SF Mono", ui-monospace, monospace` |

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Two BrokerContext constructors, never a third.** `lib/session.ts`'s `deriveContext` for cookie/session paths; `lib/broker-context.ts`'s `deriveTokenContext` for token paths. New UI routes use `getSessionUser` / `deriveContext` only.
- **`userId` and `env` are never read from a request body or query param.** `userId` comes from the verified session; `env` from the signed `wh_env` cookie via `readEnvCookie`. A planted `?user=` or `{"env":"live"}` must be provably ignored — assert it in tests.
- **Role checks are server-side and repeated per route.** A `layout.tsx` redirect is UX only. Every new API route calls `requireRole()` (Task 3) before doing anything else. Unauthenticated → `401 {"error":"unauthenticated"}`; wrong role → `403 {"error":"forbidden"}`. Exact strings — existing tests assert on them.
- **Role hierarchy:** `admin` ⊃ `manager` ⊃ `member`. `requireRole("manager")` admits admins. `requireRole("admin")` admits only admins. This matches the existing `role !== "manager" && role !== "admin"` checks in `app/api/grants/route.ts` and `.../promote/route.ts`.
- **`packages/broker` stays free of HTTP/MCP/UI/LLM imports** — enforced by the `no-restricted-imports` ESLint rule in `mvp/eslint.config.js`. New import-path code goes in the broker; new route code does not.
- **The broker is the only thing that touches `data_synth` / `data_live`.** The import path is broker code using a broker-owned pool. No route file writes SQL against a data schema. (`app/api/grants/doc-paths/route.ts` already violates this by querying `data_synth."policies__files"` on the app pool — Task 10 moves it into the broker.)
- **Audit is append-only and covers every data decision.** Imports and synthetic regeneration write `app.audit_events` rows. Never `UPDATE` or `DELETE` that table.
- **`{env:dev}` always for manually created clients.** No creation-time override, ever. Promotion is a separate manager/admin action.
- **Semantic Tailwind tokens only.** `bg-background`, `text-foreground`, `border`, `text-muted-foreground`. Never `bg-white`, `text-gray-900`, `bg-zinc-800`. Raw colours break the theme.
- **`cn()` for every conditional class.** Never string concatenation.
- Node ≥ 22, pnpm 10.33.0, TypeScript strict with `noUncheckedIndexedAccess: true` (indexing an array or record yields `T | undefined` — you will need explicit guards).
- Test DB: `pnpm test:up` (Postgres+pgvector on `127.0.0.1:54330`, plus the Keycloak service Phase 4 added) must be running. Vitest is serial (`fileParallelism: false`) and shares one Postgres.
- Vitest collects `apps/**/test/**/*.test.ts`. Playwright specs live in `apps/web/e2e/**/*.spec.ts` so the two runners never collide.
- Every task ends with a commit. Commit messages: one-line subject, no body, no `Co-Authored-By`.

---

## File Structure

**New — shared UI**
| File | Responsibility |
|---|---|
| `apps/web/app/globals.css` | *(rewritten)* Tailwind v4 import + `@theme` token block |
| `apps/web/lib/utils.ts` | `cn()` |
| `apps/web/components/ui/*.tsx` | shadcn primitives (generated, not hand-written) |
| `apps/web/components/shell/AppShell.tsx` | sidebar + topbar frame |
| `apps/web/components/shell/SidebarNav.tsx` | role-aware nav items |
| `apps/web/components/shell/EnvSwitcher.tsx` | dev/live toggle, posts `/api/env` |
| `apps/web/components/shell/UserMenu.tsx` | email, role badge, sign out |
| `apps/web/components/common/PageHeader.tsx` | title + description + primary action |
| `apps/web/components/common/EmptyState.tsx` | icon + title + description + CTA |
| `apps/web/components/common/StatusBadge.tsx` | grant status (dot + label) |
| `apps/web/components/common/OutcomeBadge.tsx` | allow/deny (glyph + label + colour) |
| `apps/web/components/common/Mono.tsx` | monospace technical value + copy button |
| `apps/web/components/common/DataTable.tsx` | TanStack Table + skeleton + empty state |

**New — authorization**
| File | Responsibility |
|---|---|
| `apps/web/lib/authz.ts` | `requireRole`, `atLeast`, `RoleError` |

**New — pages**
| Path | Surface |
|---|---|
| `apps/web/app/page.tsx` *(rewritten)* | role → redirect |
| `apps/web/app/403/page.tsx` | forbidden |
| `apps/web/app/console/page.tsx` | chat console, dev-mode only |
| `apps/web/app/admin/layout.tsx` + `page.tsx` | admin guard + overview |
| `apps/web/app/admin/collections/page.tsx` | collections & postures |
| `apps/web/app/admin/users/page.tsx` | role management |
| `apps/web/app/admin/clients/page.tsx` | OAuth clients |
| `apps/web/app/admin/sso/page.tsx` | IdP config |
| `apps/web/app/admin/audit/page.tsx` | audit browser |
| `apps/web/app/admin/import/page.tsx` | live-data import |
| `apps/web/app/manager/layout.tsx` + `page.tsx` | manager guard + inbox |
| `apps/web/app/manager/grants/page.tsx` | active grants + revoke |
| `apps/web/app/member/layout.tsx` + `page.tsx` | member guard + my grants |
| `apps/web/app/member/connect/page.tsx` | how to connect |

**New — API**
| Route | Method | Role |
|---|---|---|
| `api/admin/collections` | GET | admin |
| `api/admin/users` | GET | admin |
| `api/admin/users/[userId]` | PATCH | admin |
| `api/admin/regen-synth` | POST | admin |
| `api/admin/import` | POST | admin |
| `api/oauth-clients` | GET *(added)* | admin |
| `api/me/grants` | GET | member+ |
| `api/connect-info` | GET | member+ |

**Modified**
| File | Change |
|---|---|
| `apps/web/app/api/grants/route.ts` | fix `rowFilter`→`documentFilter`, wire terms, implement `request` |
| `apps/web/app/api/audit/route.ts` | filters + pagination + scope non-admins to own events |
| `apps/web/app/api/grants/doc-paths/route.ts` | delegate to broker `listDocumentPaths` |
| `apps/web/middleware.ts` | matchers for `/api/admin`, `/api/me`, `/api/oauth-clients`, `/api/connect-info` |
| `apps/web/tsconfig.json` | `baseUrl`, `paths: {"@/*": ["./*"]}`, include `components`/`lib`/`middleware.ts` |
| `packages/broker/src/db/pools.ts` | optional `imp` pool |
| `packages/broker/src/apply/ddl.ts` | `grantImportDDL` |
| `packages/broker/src/apply/apply.ts` | issue import grants |
| `packages/broker/src/synthetic/generate.ts` | `regenerateSynthetic` |
| `packages/cli/src/index.ts` | `runSeed` delegates to `regenerateSynthetic` |
| `scripts/dev-bootstrap.ts` | create `warehousd_import` |
| `apps/web/test/helpers/web-db.ts` | create `warehousd_import`, export `IMPORT_DATABASE_URL` |
| `packages/broker/test/helpers/db.ts` | create `warehousd_import`, add `urls.imp` |

**New — broker**
| File | Responsibility |
|---|---|
| `packages/broker/src/import/csv.ts` | RFC-4180 parser (no dependency) |
| `packages/broker/src/import/validate.ts` | rows → typed values, or per-row errors |
| `packages/broker/src/import/run.ts` | `importCollection` — insert via import pool, audit |
| `packages/broker/src/documents/paths.ts` | `listDocumentPaths` |

**Deleted**
| File | Reason |
|---|---|
| `apps/web/app/components/Grants.tsx` | replaced by Manager + Member surfaces |
| `apps/web/app/components/Evidence.tsx` | replaced by the audit browser |

---

## Task 0: Merge Phase 4 and establish the baseline

**Files:**
- Modify: whatever `git merge` touches (no hand edits expected)
- Test: the full existing suite is the deliverable

**Interfaces:**
- Produces: a `phase-5-web-ui` branch containing all of Phase 4's SSO work, a green full-suite baseline, and the confirmed env-var rename `WAREHOUSD_DISABLE_LOCAL_LOGIN`. Every later task assumes this.

- [ ] **Step 1: Bring the test stack up and record the pre-merge baseline**

```bash
cd mvp
pnpm install
pnpm test:up
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian pnpm test 2>&1 | tail -20
```

Expected: all tests pass. Write the file/test counts down — this is the regression floor.

- [ ] **Step 2: Merge `phase-4-sso`**

```bash
cd /Users/tregis/conductor/workspaces/warehousd-v1/karachi
git merge phase-4-sso
```

Expected: clean merge (Phase 5 has made no code changes yet). If Git reports conflicts, stop and report — do not resolve them by guessing.

- [ ] **Step 3: Reinstall and re-run**

```bash
cd mvp
pnpm install
pnpm test:up
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian pnpm test 2>&1 | tail -30
```

Expected: strictly more tests than Step 1, all green. The SSO suites (`sso-admin`, `sso-oidc`, `sso-local-login-disabled`, `sso-keycloak`) must be present. If `sso-keycloak` fails because Keycloak is not up, run `docker compose -f docker-compose.test.yml up -d --wait` and retry; if it still fails, note it and continue — it is not a Phase 5 dependency.

- [ ] **Step 4: Confirm the env-var rename actually landed**

```bash
cd mvp
grep -rn "SANDBOXD_DISABLE_LOCAL_LOGIN" --include="*.ts" --include="*.tsx" --include="*.mjs" --include="*.md" . | grep -v node_modules
grep -rn "WAREHOUSD_DISABLE_LOCAL_LOGIN" --include="*.ts" --include="*.mjs" . | grep -v node_modules
```

Expected: zero hits for `SANDBOXD_`, at least two for `WAREHOUSD_` (`lib/auth.ts`, `next.config.mjs`). If any `SANDBOXD_` hits remain in `mvp/`, rename them now and include the change in this task's commit.

- [ ] **Step 5: Confirm the SSO admin routes exist and are admin-gated**

```bash
cd mvp/apps/web
ls app/api/sso/providers/route.ts app/api/sso/providers/\[providerId\]/route.ts app/api/sso/status/route.ts
grep -n 'role !== "admin"' app/api/sso/providers/route.ts app/api/sso/providers/\[providerId\]/route.ts
```

Expected: all three files exist; two `role !== "admin"` hits in the first file (GET + POST), one in the second.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: merge phase-4-sso into phase-5-web-ui"
```

---

## Task 1: Tailwind v4 + shadcn/ui foundation

**Files:**
- Create: `mvp/apps/web/postcss.config.mjs`, `mvp/apps/web/lib/utils.ts`, `mvp/apps/web/components.json`
- Modify: `mvp/apps/web/app/globals.css` (rewrite), `mvp/apps/web/tsconfig.json`, `mvp/apps/web/package.json`, `mvp/apps/web/app/layout.tsx`
- Test: none (build is the verification)

**Interfaces:**
- Produces: `cn(...inputs: ClassValue[]): string` from `apps/web/lib/utils.ts`; the `@/*` path alias resolving to `apps/web/*`; the semantic token set (`--background`, `--foreground`, `--card`, `--border`, `--muted-foreground`, `--primary`, `--destructive`, `--allow`, `--deny`, `--font-mono`) in both `:root` and `@theme`. Every later UI task consumes these.

- [ ] **Step 1: Install the dependencies**

```bash
cd mvp
pnpm --filter @warehousd/web add tailwindcss@^4.3.3 @tailwindcss/postcss@^4.3.3 tw-animate-css@^1.4.0 \
  class-variance-authority@^0.7.1 clsx@^2.1.1 tailwind-merge@^3.6.0 lucide-react@^1.26.0 \
  @radix-ui/react-slot sonner@^2.0.7 @tanstack/react-table@^8.21.3 \
  react-hook-form@^7.83.0 @hookform/resolvers@^5.4.3 zod@^4.4.3
```

Note: `zod@^4` here is intentional and independent of `packages/broker`'s `zod@^3.23.0` — pnpm keeps them separate, and `@hookform/resolvers@^5` targets zod v4. Do **not** bump the broker's zod.

- [ ] **Step 2: PostCSS config**

Create `mvp/apps/web/postcss.config.mjs`:

```js
/** @type {import('postcss-load-config').Config} */
export default {
  plugins: { "@tailwindcss/postcss": {} },
};
```

Tailwind v4 has no `tailwind.config.js` — content detection is automatic and theme tokens live in CSS. Do not create one.

- [ ] **Step 3: Fix tsconfig so shadcn and the shell can resolve**

`apps/web/tsconfig.json` currently only includes `["app", "next-env.d.ts", ".next/types/**/*.ts"]` — `lib/`, `middleware.ts` and the new `components/` are outside the program. Replace the file with:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "lib": ["dom", "dom.iterable", "esnext"],
    "plugins": [{ "name": "next" }],
    "noEmit": true,
    "allowJs": true,
    "incremental": true,
    "isolatedModules": true,
    "baseUrl": ".",
    "paths": { "@/*": ["./*"] }
  },
  "include": ["app", "components", "lib", "middleware.ts", "next-env.d.ts", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: The `cn()` helper**

Create `mvp/apps/web/lib/utils.ts`:

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 5: Rewrite `globals.css` with the console theme**

Replace `mvp/apps/web/app/globals.css` entirely. The Phase 0 palette is preserved verbatim — only the token names change.

```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

/* Phase 0 "security console" palette (SPECS §14), expressed as shadcn tokens.
   Dark is the only theme: the console ships dark, `:root` IS the dark theme. */
:root {
  --background: #0d1117;
  --foreground: #e6edf3;
  --card: #161b22;
  --card-foreground: #e6edf3;
  --popover: #161b22;
  --popover-foreground: #e6edf3;
  --primary: #2f81f7;
  --primary-foreground: #ffffff;
  --secondary: #21262d;
  --secondary-foreground: #e6edf3;
  --muted: #21262d;
  --muted-foreground: #8b949e;
  --accent: #21262d;
  --accent-foreground: #e6edf3;
  --destructive: #d1242f;
  --destructive-foreground: #ffffff;
  --border: #30363d;
  --input: #30363d;
  --ring: #2f81f7;
  --radius: 0.5rem;

  /* Governance semantics — never expressed by colour alone (see OutcomeBadge). */
  --allow: #2ea043;
  --deny: #d1242f;
  --pending: #d29922;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-allow: var(--allow);
  --color-deny: var(--deny);
  --color-pending: var(--pending);
  --radius-lg: var(--radius);
  --radius-md: calc(var(--radius) - 2px);
  --radius-sm: calc(var(--radius) - 4px);
  --font-mono: "SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}

@layer base {
  * { @apply border-border outline-ring/50; }
  body { @apply bg-background text-foreground antialiased; }
}

/* Markdown rendering inside the chat console (kept from Phase 0). */
.markdown table { @apply my-1 border-collapse; }
.markdown th, .markdown td { @apply border border-border px-2 py-1 text-left; }
.markdown blockquote { @apply my-1 border-l-[3px] border-muted-foreground pl-2 text-muted-foreground; }
.markdown p { @apply my-1; }
.markdown code { @apply rounded-sm bg-background px-1 py-px font-mono; }
```

The old `.panel`, `.mono`, `.allow::before`, `.deny::before` rules are deliberately gone — Task 2 replaces them with components. Tasks 4 and 5 update the last consumers.

- [ ] **Step 6: Root layout gets the dark class and the toaster mount point**

Replace `mvp/apps/web/app/layout.tsx`:

```tsx
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

export const metadata = { title: "warehousd — security console" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        {children}
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
```

This will not compile until Task 2 generates `components/ui/sonner.tsx`. That is expected — the two tasks are verified together in Task 2 Step 4. Do not run the build yet.

- [ ] **Step 7: shadcn config**

Create `mvp/apps/web/components.json`:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/postcss.config.mjs apps/web/components.json apps/web/lib/utils.ts \
  apps/web/app/globals.css apps/web/app/layout.tsx apps/web/tsconfig.json \
  apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): tailwind v4 + shadcn foundation on the console palette"
```

---

## Task 2: shadcn primitives and shared components

**Files:**
- Create: `mvp/apps/web/components/ui/*.tsx` (generated), `mvp/apps/web/components/common/{PageHeader,EmptyState,StatusBadge,OutcomeBadge,Mono,DataTable}.tsx`
- Test: none (build + a throwaway render is the verification)

**Interfaces:**
- Produces:
  - `PageHeader({ title, description?, action? })`
  - `EmptyState({ icon, title, description, action? })`
  - `StatusBadge({ status: "pending"|"approved"|"denied"|"revoked"|"expired" })`
  - `OutcomeBadge({ outcome: "allowed"|"refused", reason?: string|null })`
  - `Mono({ children, copyable? })`
  - `DataTable<T>({ columns, data, loading?, empty })`
- Consumes: `cn()` and the tokens from Task 1.

- [ ] **Step 1: Generate the shadcn primitives**

```bash
cd mvp/apps/web
npx shadcn@latest add button badge card table input label textarea select checkbox \
  dialog alert-dialog sheet tabs dropdown-menu tooltip popover command separator \
  skeleton scroll-area form sonner switch --yes --overwrite
```

Expected: files appear under `components/ui/`, and the CLI may append its own vars to `globals.css`. **If it rewrites the `:root` block, restore the Task 1 values** (`git diff app/globals.css` and keep our hex values; keep any `--sidebar-*` vars it adds).

- [ ] **Step 2: `Mono` — the technical-value primitive**

Create `mvp/apps/web/components/common/Mono.tsx`:

```tsx
"use client";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function Mono({
  children, copyable = false, className,
}: { children: string; copyable?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className={cn("inline-flex items-center gap-1 font-mono text-xs", className)}>
      <span className="truncate">{children}</span>
      {copyable && (
        <Button
          variant="ghost" size="icon" aria-label="Copy value"
          className="size-5 shrink-0"
          onClick={() => {
            navigator.clipboard.writeText(children);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </Button>
      )}
    </span>
  );
}
```

- [ ] **Step 3: The governance badges**

Create `mvp/apps/web/components/common/StatusBadge.tsx`:

```tsx
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const CONFIG = {
  pending:  { label: "Pending",  dot: "bg-pending",  variant: "outline" as const },
  approved: { label: "Approved", dot: "bg-allow",    variant: "outline" as const },
  denied:   { label: "Denied",   dot: "bg-deny",     variant: "outline" as const },
  revoked:  { label: "Revoked",  dot: "bg-deny",     variant: "outline" as const },
  expired:  { label: "Expired",  dot: "bg-muted-foreground", variant: "outline" as const },
};

export type GrantStatus = keyof typeof CONFIG;

export function StatusBadge({ status }: { status: GrantStatus }) {
  const c = CONFIG[status];
  return (
    <Badge variant={c.variant} className="gap-1.5" role="status">
      <span className={cn("size-1.5 rounded-full", c.dot)} />
      {c.label}
    </Badge>
  );
}
```

Create `mvp/apps/web/components/common/OutcomeBadge.tsx`. Colour is never the only signal — the glyph and the label both carry the meaning (SPECS §14):

```tsx
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export function OutcomeBadge({
  outcome, reason,
}: { outcome: "allowed" | "refused"; reason?: string | null }) {
  const allowed = outcome === "allowed";
  return (
    <Badge
      variant="outline"
      role="status"
      className={cn("gap-1.5 font-mono text-xs", allowed ? "text-allow" : "text-deny")}
    >
      <span aria-hidden>{allowed ? "✓" : "✗"}</span>
      {allowed ? "allow" : "deny"}
      {!allowed && reason ? <span className="text-muted-foreground">· {reason}</span> : null}
    </Badge>
  );
}
```

- [ ] **Step 4: `PageHeader` and `EmptyState`**

Create `mvp/apps/web/components/common/PageHeader.tsx`:

```tsx
export function PageHeader({
  title, description, action,
}: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}
```

Create `mvp/apps/web/components/common/EmptyState.tsx`:

```tsx
import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon, title, description, action,
}: { icon: LucideIcon; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="mb-4 rounded-full bg-muted p-3">
        <Icon size={24} className="text-muted-foreground" />
      </div>
      <h3 className="mb-1 text-sm font-medium">{title}</h3>
      <p className="mb-4 max-w-xs text-sm text-muted-foreground">{description}</p>
      {action}
    </div>
  );
}
```

- [ ] **Step 5: `DataTable` — the workhorse**

Create `mvp/apps/web/components/common/DataTable.tsx`:

```tsx
"use client";
import {
  flexRender, getCoreRowModel, getSortedRowModel, useReactTable,
  type ColumnDef, type SortingState,
} from "@tanstack/react-table";
import { useState } from "react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

export function DataTable<T>({
  columns, data, loading = false, empty,
}: {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  loading?: boolean;
  empty: React.ReactNode;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const table = useReactTable({
    data, columns, state: { sorting }, onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id}>
              {hg.headers.map((h) => (
                <TableHead key={h.id}>
                  {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {loading
            ? Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {columns.map((_c, j) => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))
            : table.getRowModel().rows.length === 0
              ? (
                <TableRow>
                  <TableCell colSpan={columns.length}>{empty}</TableCell>
                </TableRow>
              )
              : table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 6: Typecheck**

```bash
cd mvp/apps/web && npx tsc --noEmit
```

Expected: errors only from `app/page.tsx`, `app/components/Chat.tsx`, `app/components/Evidence.tsx`, `app/components/Grants.tsx` — the Phase 0 files still referencing the deleted `.panel` / `.mono` classes compile fine (they are class strings, not types), so realistically: **no errors**. Any error inside `components/ui/**` or `components/common/**` must be fixed before moving on.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components apps/web/app/globals.css apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): shadcn primitives and shared console components"
```

---

## Task 3: `requireRole` — the single authorization primitive

**Files:**
- Create: `mvp/apps/web/lib/authz.ts`
- Test: `mvp/apps/web/test/authz.integration.test.ts`

**Interfaces:**
- Produces:
  - `type Role = "admin" | "manager" | "member"`
  - `atLeast(actual: Role, required: Role): boolean` — pure, hierarchy-aware
  - `requireRole(req: Request, required: Role): Promise<{ ok: true; user: SessionUser } | { ok: false; response: Response }>`
  - `requireSession(req: Request): Promise<{ ok: true; user: SessionUser } | { ok: false; response: Response }>`
- Consumes: `getSessionUser` from `lib/session.ts`, `SessionUser` from `lib/auth.ts`.
- Every API route from Task 6 onward begins with one of these two calls.

- [ ] **Step 1: Write the failing test**

Create `mvp/apps/web/test/authz.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { atLeast, requireRole, requireSession } from "../lib/authz";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let miaCookie: string, marcusCookie: string, anaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("authz");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@meridian.demo", "demo");
  anaCookie = await signIn(db.auth, "ana@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

function req(cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers["cookie"] = cookie;
  return new Request("http://localhost:8722/api/whatever", { headers });
}

describe("atLeast", () => {
  it("admin satisfies every requirement", () => {
    expect(atLeast("admin", "admin")).toBe(true);
    expect(atLeast("admin", "manager")).toBe(true);
    expect(atLeast("admin", "member")).toBe(true);
  });
  it("manager satisfies manager and member but not admin", () => {
    expect(atLeast("manager", "admin")).toBe(false);
    expect(atLeast("manager", "manager")).toBe(true);
    expect(atLeast("manager", "member")).toBe(true);
  });
  it("member satisfies only member", () => {
    expect(atLeast("member", "admin")).toBe(false);
    expect(atLeast("member", "manager")).toBe(false);
    expect(atLeast("member", "member")).toBe(true);
  });
});

describe("requireSession", () => {
  it("401s with the exact unauthenticated shape when there is no cookie", async () => {
    const r = await requireSession(req());
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(401);
    expect(await r.response.json()).toEqual({ error: "unauthenticated" });
  });

  it("returns the session user for any signed-in role", async () => {
    const r = await requireSession(req(miaCookie));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.user.id).toBe("mia");
    expect(r.user.role).toBe("member");
  });
});

describe("requireRole", () => {
  it("401s without a session before it ever considers the role", async () => {
    const r = await requireRole(req(), "member");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(401);
  });

  it("403s with the exact forbidden shape when the role is too low", async () => {
    const r = await requireRole(req(miaCookie), "manager");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(403);
    expect(await r.response.json()).toEqual({ error: "forbidden" });
  });

  it("admits a manager to a manager-gated route", async () => {
    const r = await requireRole(req(marcusCookie), "manager");
    expect(r.ok).toBe(true);
  });

  it("admits an admin to a manager-gated route (hierarchy)", async () => {
    const r = await requireRole(req(anaCookie), "manager");
    expect(r.ok).toBe(true);
  });

  it("refuses a manager on an admin-gated route", async () => {
    const r = await requireRole(req(marcusCookie), "admin");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/authz.integration.test.ts
```

Expected: FAIL — `Failed to resolve import "../lib/authz"`.

- [ ] **Step 3: Implement**

Create `mvp/apps/web/lib/authz.ts`:

```ts
import { getSessionUser } from "./session";
import type { SessionUser } from "./auth";

export type Role = SessionUser["role"];

// admin ⊃ manager ⊃ member. A route gated at "manager" admits admins too — this mirrors
// the pre-existing `role !== "manager" && role !== "admin"` checks in the grants and
// client-promotion routes, which this helper replaces.
const RANK: Record<Role, number> = { member: 0, manager: 1, admin: 2 };

export function atLeast(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}

export type Guard =
  | { ok: true; user: SessionUser }
  | { ok: false; response: Response };

// Authorization is enforced here, per route — never in a layout. A layout redirect is UX;
// this is the gate. Error bodies are byte-identical to the hand-rolled checks they replace
// ({error:"unauthenticated"} / {error:"forbidden"}) because existing tests assert on them.
export async function requireSession(req: Request): Promise<Guard> {
  const user = await getSessionUser(req);
  if (!user) {
    return { ok: false, response: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  }
  return { ok: true, user };
}

export async function requireRole(req: Request, required: Role): Promise<Guard> {
  const s = await requireSession(req);
  if (!s.ok) return s;
  if (!atLeast(s.user.role, required)) {
    return { ok: false, response: Response.json({ error: "forbidden" }, { status: 403 }) };
  }
  return s;
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/authz.integration.test.ts
```

Expected: PASS, 11/11.

- [ ] **Step 5: Adopt it in the two routes that already hand-roll the check**

In `mvp/apps/web/app/api/oauth-clients/[clientId]/promote/route.ts`, replace the opening lines:

```ts
import { requireRole } from "../../../../../lib/authz";

export async function POST(req: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const guard = await requireRole(req, "manager");
  if (!guard.ok) return guard.response;
  const sessionUser = guard.user;
  const { clientId } = await params;
  // …unchanged from here
```

Delete the now-unused `getSessionUser` import from that file.

- [ ] **Step 6: Prove the refactor changed no behaviour**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/oauth-clients.integration.test.ts
```

Expected: PASS — the existing "member cannot promote → 403" and "manager can promote" tests still hold.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/authz.ts apps/web/test/authz.integration.test.ts \
  "apps/web/app/api/oauth-clients/[clientId]/promote/route.ts"
git commit -m "feat(web): requireRole authorization primitive with role hierarchy"
```

---

## Task 4: App shell and role-aware routing

**Files:**
- Create: `mvp/apps/web/components/shell/{AppShell,SidebarNav,EnvSwitcher,UserMenu}.tsx`, `mvp/apps/web/lib/nav.ts`, `mvp/apps/web/app/403/page.tsx`, `mvp/apps/web/app/{admin,manager,member}/layout.tsx`, `mvp/apps/web/app/{admin,manager,member}/page.tsx` (placeholders)
- Modify: `mvp/apps/web/app/page.tsx` (rewrite as a redirect), `mvp/apps/web/middleware.ts`
- Test: `mvp/apps/web/test/route-guards.integration.test.ts`

**Interfaces:**
- Produces: `<AppShell role={Role}>` wrapping every surface; `NAV: Record<Role, NavItem[]>` from `lib/nav.ts`; the `/admin`, `/manager`, `/member` segments each guarded by an async server layout.
- Consumes: `requireRole` / `atLeast` (Task 3), `PageHeader` (Task 2).

- [ ] **Step 1: Nav definition**

Create `mvp/apps/web/lib/nav.ts`:

```ts
import {
  Boxes, FileUp, KeyRound, ScrollText, ShieldCheck, Users,
  Inbox, ListChecks, Plug, MessagesSquare, LayoutDashboard,
} from "lucide-react";
import type { Role } from "./authz";

export type NavItem = { href: string; label: string; icon: typeof Boxes };

// One nav list per role. A role's list contains ONLY routes that role may reach —
// the layout guards enforce it, this just avoids showing dead links.
export const NAV: Record<Role, NavItem[]> = {
  admin: [
    { href: "/admin", label: "Overview", icon: LayoutDashboard },
    { href: "/admin/collections", label: "Collections", icon: Boxes },
    { href: "/admin/users", label: "Users & roles", icon: Users },
    { href: "/admin/clients", label: "Clients", icon: KeyRound },
    { href: "/admin/sso", label: "SSO", icon: ShieldCheck },
    { href: "/admin/audit", label: "Audit", icon: ScrollText },
    { href: "/admin/import", label: "Import", icon: FileUp },
  ],
  manager: [
    { href: "/manager", label: "Grant inbox", icon: Inbox },
    { href: "/manager/grants", label: "Active grants", icon: ListChecks },
  ],
  member: [
    { href: "/member", label: "My grants", icon: ListChecks },
    { href: "/member/connect", label: "How to connect", icon: Plug },
  ],
};

// The chat console is a dev bench, not a product surface (SPECS §13 is Phase 0).
export const CONSOLE_ITEM: NavItem = { href: "/console", label: "Chat console", icon: MessagesSquare };
```

- [ ] **Step 2: Sidebar, env switcher, user menu**

Create `mvp/apps/web/components/shell/SidebarNav.tsx`:

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { NavItem } from "@/lib/nav";

export function SidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5 px-2">
      {items.map(({ href, label, icon: Icon }) => {
        // Exact match for section roots so /admin doesn't stay lit on /admin/audit.
        const active = pathname === href || (href !== "/admin" && pathname.startsWith(href + "/"));
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
              "text-muted-foreground hover:bg-accent hover:text-foreground",
              active && "bg-accent font-medium text-foreground",
            )}
          >
            <Icon size={16} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
```

Create `mvp/apps/web/components/shell/EnvSwitcher.tsx`. Env is a **cookie** write, never a body param on data routes:

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function EnvSwitcher({ initial }: { initial: "dev" | "live" }) {
  const [env, setEnv] = useState(initial);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  async function pick(next: "dev" | "live") {
    if (next === env) return;
    const prev = env;
    setEnv(next); // optimistic
    const res = await fetch("/api/env", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: next }),
    });
    if (!res.ok) { setEnv(prev); toast.error("Could not switch environment"); return; }
    startTransition(() => router.refresh());
  }

  return (
    <div role="group" aria-label="Environment" className="flex rounded-md border p-0.5">
      {(["dev", "live"] as const).map((e) => (
        <button
          key={e}
          onClick={() => pick(e)}
          disabled={pending}
          aria-pressed={env === e}
          className={cn(
            "rounded-sm px-2.5 py-1 font-mono text-xs transition-colors",
            env === e ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {e}
        </button>
      ))}
    </div>
  );
}
```

Create `mvp/apps/web/components/shell/UserMenu.tsx`:

```tsx
"use client";
import { LogOut } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function UserMenu({ email, role }: { email: string; role: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2">
          <span className="text-sm">{email}</span>
          <Badge variant="secondary" className="font-mono text-[10px] uppercase">{role}</Badge>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={async () => { await authClient.signOut(); window.location.href = "/login"; }}
        >
          <LogOut size={16} className="mr-2" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 3: The shell**

Create `mvp/apps/web/components/shell/AppShell.tsx`:

```tsx
import { NAV, CONSOLE_ITEM } from "@/lib/nav";
import type { Role } from "@/lib/authz";
import { SidebarNav } from "./SidebarNav";
import { EnvSwitcher } from "./EnvSwitcher";
import { UserMenu } from "./UserMenu";

export function AppShell({
  role, email, env, showConsole, children,
}: {
  role: Role; email: string; env: "dev" | "live"; showConsole: boolean;
  children: React.ReactNode;
}) {
  const items = showConsole ? [...NAV[role], CONSOLE_ITEM] : NAV[role];
  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-60 shrink-0 flex-col border-r">
        <div className="flex h-14 items-center px-5 text-sm font-semibold">
          warehousd
          <span className="ml-2 font-mono text-[10px] font-normal text-muted-foreground">
            security console
          </span>
        </div>
        <SidebarNav items={items} />
      </aside>
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-end gap-3 border-b px-6">
          <EnvSwitcher initial={env} />
          <UserMenu email={email} role={role} />
        </header>
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: The guarded layouts**

Create `mvp/apps/web/app/admin/layout.tsx`:

```tsx
import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { atLeast, type Role } from "@/lib/authz";
import { AppShell } from "@/components/shell/AppShell";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");
  const role = (session.user as { role?: Role }).role ?? "member";
  // UX guard only — every /api/admin/* route repeats this check with requireRole.
  if (!atLeast(role, "admin")) redirect("/403");
  const env = (await cookies()).get("wh_env")?.value === "live" ? "live" : "dev";
  return (
    <AppShell
      role={role} email={session.user.email} env={env}
      showConsole={process.env.NODE_ENV !== "production" || process.env.WAREHOUSD_DEMO === "true"}
    >
      {children}
    </AppShell>
  );
}
```

Create `mvp/apps/web/app/manager/layout.tsx` — identical except `atLeast(role, "manager")` and the exported name `ManagerLayout`:

```tsx
import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { atLeast, type Role } from "@/lib/authz";
import { AppShell } from "@/components/shell/AppShell";

export default async function ManagerLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");
  const role = (session.user as { role?: Role }).role ?? "member";
  if (!atLeast(role, "manager")) redirect("/403");
  const env = (await cookies()).get("wh_env")?.value === "live" ? "live" : "dev";
  return (
    <AppShell
      role={role} email={session.user.email} env={env}
      showConsole={process.env.NODE_ENV !== "production" || process.env.WAREHOUSD_DEMO === "true"}
    >
      {children}
    </AppShell>
  );
}
```

Create `mvp/apps/web/app/member/layout.tsx` — identical except `atLeast(role, "member")` and the name `MemberLayout`:

```tsx
import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { atLeast, type Role } from "@/lib/authz";
import { AppShell } from "@/components/shell/AppShell";

export default async function MemberLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");
  const role = (session.user as { role?: Role }).role ?? "member";
  if (!atLeast(role, "member")) redirect("/403");
  const env = (await cookies()).get("wh_env")?.value === "live" ? "live" : "dev";
  return (
    <AppShell
      role={role} email={session.user.email} env={env}
      showConsole={process.env.NODE_ENV !== "production" || process.env.WAREHOUSD_DEMO === "true"}
    >
      {children}
    </AppShell>
  );
}
```

> A manager or admin landing on `/member` sees the **member** nav from `NAV[role]` — which is wrong. Fix it by passing the *surface*, not the actor: change each layout's `<AppShell role={...}>` to the literal surface (`"admin"`, `"manager"`, `"member"`) and pass the actor's role separately for the badge. Do that now: give `AppShell` a `surface: Role` prop used for `NAV[surface]`, and keep `role` for `UserMenu`. Update all three layouts to pass `surface="admin" | "manager" | "member"` and `role={role}`.

- [ ] **Step 5: Root redirect, 403 page, placeholder pages**

Replace `mvp/apps/web/app/page.tsx` (it is currently the three-column console):

```tsx
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export default async function Home() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");
  const role = (session.user as { role?: string }).role ?? "member";
  redirect(role === "admin" ? "/admin" : role === "manager" ? "/manager" : "/member");
}
```

Create `mvp/apps/web/app/403/page.tsx`:

```tsx
import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Forbidden() {
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-4 text-center">
      <div className="rounded-full bg-muted p-3"><ShieldAlert size={24} className="text-deny" /></div>
      <h1 className="text-xl font-semibold">You don&rsquo;t have access to this area</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        This surface is restricted by role. If you believe you should have access, ask an
        administrator to change your role.
      </p>
      <Button asChild variant="outline"><Link href="/">Back to your workspace</Link></Button>
    </main>
  );
}
```

Create three placeholders — each is replaced by a later task, but they must exist now so the shell renders:

`mvp/apps/web/app/admin/page.tsx`:
```tsx
import { PageHeader } from "@/components/common/PageHeader";
export default function AdminOverview() {
  return <PageHeader title="Overview" description="Collections, identity and audit for this deployment." />;
}
```

`mvp/apps/web/app/manager/page.tsx`:
```tsx
import { PageHeader } from "@/components/common/PageHeader";
export default function ManagerInbox() {
  return <PageHeader title="Grant inbox" description="Requests waiting on your decision." />;
}
```

`mvp/apps/web/app/member/page.tsx`:
```tsx
import { PageHeader } from "@/components/common/PageHeader";
export default function MemberGrants() {
  return <PageHeader title="My grants" description="What you can query, and what you've asked for." />;
}
```

- [ ] **Step 6: Extend the middleware matcher**

In `mvp/apps/web/middleware.ts`, replace the `config` export (keep the Phase 4 SSO entries):

```ts
export const config = {
  matcher: [
    "/api/chat/:path*",
    "/api/grants/:path*",
    "/api/audit/:path*",
    "/api/env/:path*",
    "/api/sso/providers",
    "/api/sso/providers/:path*",
    "/api/admin/:path*",
    "/api/me/:path*",
    "/api/oauth-clients/:path*",
    "/api/connect-info",
  ],
};
```

`/api/sso/status` stays unmatched — the login page fetches it before there is a session.

- [ ] **Step 7: Write the route-guard test**

Create `mvp/apps/web/test/route-guards.integration.test.ts`. This is the §5 acceptance gate "each surface 403s for lower roles", asserted at the API layer where it is actually enforced:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { requireRole } from "../lib/authz";

let db: Awaited<ReturnType<typeof setupWebDb>>;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  db = await setupWebDb("guards");
  cookies.mia = await signIn(db.auth, "mia@meridian.demo", "demo");
  cookies.marcus = await signIn(db.auth, "marcus@meridian.demo", "demo");
  cookies.ana = await signIn(db.auth, "ana@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

function req(cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  return new Request("http://localhost:8722/x", { headers });
}

// (actor, surface) → expected outcome. Kept as data so later tasks add rows, not code.
const MATRIX: [keyof typeof cookies, "admin" | "manager" | "member", boolean][] = [
  ["mia", "member", true],   ["mia", "manager", false],   ["mia", "admin", false],
  ["marcus", "member", true], ["marcus", "manager", true], ["marcus", "admin", false],
  ["ana", "member", true],   ["ana", "manager", true],    ["ana", "admin", true],
];

describe("surface authorization matrix", () => {
  for (const [who, surface, allowed] of MATRIX) {
    it(`${who} ${allowed ? "may" : "may not"} reach a ${surface}-gated route`, async () => {
      const r = await requireRole(req(cookies[who]), surface);
      expect(r.ok).toBe(allowed);
      if (!r.ok) expect(r.response.status).toBe(403);
    });
  }

  it("an anonymous caller gets 401, not 403, on every surface", async () => {
    for (const surface of ["member", "manager", "admin"] as const) {
      const r = await requireRole(req(), surface);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.response.status).toBe(401);
    }
  });
});
```

- [ ] **Step 8: Run the test and the build**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/route-guards.integration.test.ts
cd apps/web && npx tsc --noEmit
```

Expected: 10/10 pass; typecheck clean except for errors in `app/components/{Chat,Evidence,Grants}.tsx` if any — those files are still referenced by nothing now that `app/page.tsx` is a redirect. Leave them; Task 5 relocates `Chat`, Task 11 and Task 14 delete the other two.

- [ ] **Step 9: Commit**

```bash
git add apps/web/components/shell apps/web/lib/nav.ts apps/web/app/403 \
  apps/web/app/admin apps/web/app/manager apps/web/app/member \
  apps/web/app/page.tsx apps/web/middleware.ts apps/web/test/route-guards.integration.test.ts
git commit -m "feat(web): role-aware app shell and guarded /admin /manager /member segments"
```

---

## Task 5: Demote the chat console to a dev-only surface

**Files:**
- Create: `mvp/apps/web/app/console/page.tsx`, `mvp/apps/web/app/console/layout.tsx`
- Modify: `mvp/apps/web/app/components/Chat.tsx` (restyle only)
- Test: `mvp/apps/web/test/console-gate.test.ts`

**Interfaces:**
- Produces: `/console` — the Phase 0 chat bench, reachable only when `NODE_ENV !== "production"` or `WAREHOUSD_DEMO === "true"`; `notFound()` otherwise.
- Consumes: `AppShell` (Task 4), the existing `Chat` component and `/api/chat` route (unchanged behaviour).

- [ ] **Step 1: Write the failing test**

Create `mvp/apps/web/test/console-gate.test.ts` — a pure unit test of the gate predicate, so it needs no DB:

```ts
import { describe, it, expect } from "vitest";
import { consoleEnabled } from "../lib/console-gate";

describe("consoleEnabled", () => {
  it("is on in development", () => {
    expect(consoleEnabled({ NODE_ENV: "development" })).toBe(true);
  });
  it("is on in production when demo mode is explicitly enabled", () => {
    expect(consoleEnabled({ NODE_ENV: "production", WAREHOUSD_DEMO: "true" })).toBe(true);
  });
  it("is off in production by default", () => {
    expect(consoleEnabled({ NODE_ENV: "production" })).toBe(false);
  });
  it("is off in production when demo mode is any value other than the literal 'true'", () => {
    expect(consoleEnabled({ NODE_ENV: "production", WAREHOUSD_DEMO: "1" })).toBe(false);
    expect(consoleEnabled({ NODE_ENV: "production", WAREHOUSD_DEMO: "yes" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd mvp && npx vitest run apps/web/test/console-gate.test.ts
```

Expected: FAIL — cannot resolve `../lib/console-gate`.

- [ ] **Step 3: Implement the gate**

Create `mvp/apps/web/lib/console-gate.ts`:

```ts
// The chat console is the Phase 0 demo bench, not a governed product surface. It ships
// in dev and in explicit demo mode only — a deployed production instance must not expose
// an LLM-driven query surface that nothing in §8 asks for.
export function consoleEnabled(env: { NODE_ENV?: string; WAREHOUSD_DEMO?: string }): boolean {
  if (env.NODE_ENV !== "production") return true;
  return env.WAREHOUSD_DEMO === "true";
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd mvp && npx vitest run apps/web/test/console-gate.test.ts
```

Expected: PASS, 4/4.

- [ ] **Step 5: Build the `/console` route**

Create `mvp/apps/web/app/console/layout.tsx`:

```tsx
import { headers, cookies } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import type { Role } from "@/lib/authz";
import { consoleEnabled } from "@/lib/console-gate";
import { AppShell } from "@/components/shell/AppShell";

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  if (!consoleEnabled(process.env)) notFound();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");
  const role = (session.user as { role?: Role }).role ?? "member";
  const env = (await cookies()).get("wh_env")?.value === "live" ? "live" : "dev";
  const surface: Role = role === "admin" ? "admin" : role === "manager" ? "manager" : "member";
  return (
    <AppShell surface={surface} role={role} email={session.user.email} env={env} showConsole>
      {children}
    </AppShell>
  );
}
```

Create `mvp/apps/web/app/console/page.tsx`:

```tsx
import { PageHeader } from "@/components/common/PageHeader";
import { Chat } from "../components/Chat";

export default function ConsolePage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Chat console"
        description="A local MCP test bench. Every tool call runs through the broker and is audited like any other client."
      />
      <div className="min-h-0 flex-1"><Chat onTurn={() => {}} /></div>
    </div>
  );
}
```

- [ ] **Step 6: Restyle `Chat.tsx` onto the token set**

Read `mvp/apps/web/app/components/Chat.tsx` first. Replace its outer container's inline styles and the `className="panel"` / `className="mono"` usages with Tailwind equivalents — `panel` → `rounded-lg border bg-card p-3`, `mono` → `font-mono text-xs`. **Do not touch the NDJSON stream reader, the message state machine, or the fabrication-guard handling** — §10 test 12 depends on that logic and it is not in scope here.

- [ ] **Step 7: Verify the console still works end to end**

```bash
cd mvp
docker compose -f docker-compose.test.yml up -d --wait
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian \
APP_DATABASE_URL=postgres://postgres:postgres@localhost:54330/warehousd_test \
  pnpm tsx scripts/dev-bootstrap.ts
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
WAREHOUSD_DEMO=true \
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian \
APP_DATABASE_URL=postgres://postgres:postgres@localhost:54330/warehousd_test \
DEV_DATABASE_URL=postgres://warehousd_dev:pw@localhost:54330/warehousd_test \
LIVE_DATABASE_URL=postgres://warehousd_live:pw@localhost:54330/warehousd_test \
  pnpm --filter @warehousd/web dev
```

Sign in as `mia@meridian.demo` / `demo`, land on `/member`, click **Chat console**, ask *"what does the remote work policy say?"*. Expected: a streamed answer sourced from `search_documents`. Then confirm `/` redirects by role for all three personas.

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/console apps/web/lib/console-gate.ts \
  apps/web/app/components/Chat.tsx apps/web/test/console-gate.test.ts
git commit -m "feat(web): move the chat console to a dev-only /console surface"
```

---

## Task 6: Member — my grants (and closing the pending-queue leak)

**Files:**
- Create: `mvp/apps/web/app/api/me/grants/route.ts`, `mvp/apps/web/app/member/MyGrants.tsx`
- Modify: `mvp/apps/web/app/api/grants/route.ts` (scope `pending` to manager+), `mvp/apps/web/app/member/page.tsx`
- Test: `mvp/apps/web/test/me-grants.integration.test.ts`

**Interfaces:**
- Produces: `GET /api/me/grants` → `{ grants: MeGrant[] }` where
  `MeGrant = { id, collection, env, status, effectiveStatus, allowed_fields, purpose_label, purpose_detail, requested_at, decided_at, expires_at, document_filter, collectionType, taxonomyField }`.
  `effectiveStatus` is `"expired"` when `status === "approved"` and `expires_at` is in the past, otherwise `status` — the UI must never show "Approved" for a grant the broker will refuse.
- Consumes: `requireSession` (Task 3), `loadConfig`, `getAppPool`.

**Background:** `GET /api/grants` today runs `select * from app.grants where status='pending'` with **no role filter** and returns it to every authenticated caller. `Grants.tsx` only renders it for managers, but the data is on the wire regardless — a member can read every pending request in the organisation (who asked for what, with what purpose) by calling the endpoint directly. Fix it here.

- [ ] **Step 1: Write the failing test**

Create `mvp/apps/web/test/me-grants.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let miaCookie: string, marcusCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("megrants");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@meridian.demo", "demo");
  const app = getAppPool();
  await app.query(
    `insert into app.grants (user_id,collection,env,status,allowed_fields,purpose_label)
     values ('mia','announcements','dev','approved',array['id','title'],'newsletter')`);
  await app.query(
    `insert into app.grants (user_id,collection,env,status,allowed_fields,expires_at)
     values ('mia','metrics','dev','approved',array['id','date'], now() - interval '1 day')`);
  await app.query(
    `insert into app.grants (user_id,collection,env,status,allowed_fields,purpose_label)
     values ('marcus','salaries','dev','pending',array['id'],'comp review')`);
}, 60_000);
afterAll(async () => { await db?.end(); });

function req(url: string, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  return new Request(`http://localhost:8722${url}`, { headers });
}

describe("GET /api/me/grants", () => {
  it("401s without a session", async () => {
    const { GET } = await import("../app/api/me/grants/route");
    const res = await GET(req("/api/me/grants") as any);
    expect(res.status).toBe(401);
  });

  it("returns only the caller's own grants", async () => {
    const { GET } = await import("../app/api/me/grants/route");
    const body = await (await GET(req("/api/me/grants", miaCookie) as any)).json();
    expect(body.grants.length).toBeGreaterThan(0);
    for (const g of body.grants) expect(g.user_id).toBe("mia");
    expect(body.grants.some((g: any) => g.collection === "salaries")).toBe(false);
  });

  it("ignores a planted ?user= param", async () => {
    const { GET } = await import("../app/api/me/grants/route");
    const body = await (await GET(req("/api/me/grants?user=marcus", miaCookie) as any)).json();
    for (const g of body.grants) expect(g.user_id).toBe("mia");
  });

  it("reports an approved-but-past-expiry grant as expired", async () => {
    const { GET } = await import("../app/api/me/grants/route");
    const body = await (await GET(req("/api/me/grants", miaCookie) as any)).json();
    const metrics = body.grants.find((g: any) => g.collection === "metrics");
    expect(metrics.status).toBe("approved");
    expect(metrics.effectiveStatus).toBe("expired");
  });

  it("annotates file collections with their type and taxonomy field", async () => {
    const app = getAppPool();
    await app.query(
      `insert into app.grants (user_id,collection,env,status,allowed_fields)
       values ('mia','policies','live','pending',array['title'])`);
    const { GET } = await import("../app/api/me/grants/route");
    const body = await (await GET(req("/api/me/grants", miaCookie) as any)).json();
    const policies = body.grants.find((g: any) => g.collection === "policies");
    expect(policies.collectionType).toBe("file");
    expect(policies.taxonomyField).toBe("category");
  });
});

describe("GET /api/grants pending queue", () => {
  it("does not disclose other users' pending requests to a member", async () => {
    const { GET } = await import("../app/api/grants/route");
    const body = await (await GET(req("/api/grants", miaCookie) as any)).json();
    expect(body.pending).toEqual([]);
  });

  it("still returns the pending queue to a manager", async () => {
    const { GET } = await import("../app/api/grants/route");
    const body = await (await GET(req("/api/grants", marcusCookie) as any)).json();
    expect(body.pending.some((g: any) => g.collection === "salaries")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/me-grants.integration.test.ts
```

Expected: FAIL — cannot resolve `../app/api/me/grants/route`, and the last-but-one test fails because `pending` currently leaks.

- [ ] **Step 3: Implement the route**

Create `mvp/apps/web/app/api/me/grants/route.ts`:

```ts
import { NextRequest } from "next/server";
import { loadConfig } from "@warehousd/broker";
import { getAppPool } from "../../../lib/broker";
import { requireSession } from "../../../../lib/authz";

const projectDir = process.env.WAREHOUSD_PROJECT_DIR!;

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if (!guard.ok) return guard.response;
  // user_id comes from the verified session — a ?user= param is never read.
  const cfg = loadConfig(projectDir);
  const r = await getAppPool().query(
    `select * from app.grants where user_id=$1 order by requested_at desc`, [guard.user.id]);

  const now = Date.now();
  const grants = r.rows.map((g) => {
    const expired =
      g.status === "approved" && g.expires_at !== null && new Date(g.expires_at).getTime() <= now;
    const c = cfg.collections[g.collection];
    return {
      ...g,
      // The broker refuses an expired grant with no_grant; the UI must say so rather than
      // showing a green "Approved" the user cannot actually use.
      effectiveStatus: expired ? "expired" : g.status,
      collectionType: c?.type ?? "dataset",
      taxonomyField: c?.taxonomy ?? null,
    };
  });
  return Response.json({ grants });
}
```

- [ ] **Step 4: Close the pending leak**

In `mvp/apps/web/app/api/grants/route.ts`, replace the `GET` handler's body. Import `requireSession` and `atLeast` from `../../../lib/authz` and drop the `getSessionUser` import:

```ts
export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if (!guard.ok) return guard.response;
  const user = guard.user;
  const app = getAppPool();
  const cfg = loadConfig(projectDir);
  const mine = await app.query(
    `select * from app.grants where user_id=$1 order by requested_at desc`, [user.id]);
  // The pending queue is approver-only data: it names who asked for what, and why. A member
  // calling this endpoint directly used to receive the whole organisation's queue.
  const pending = atLeast(user.role, "manager")
    ? await app.query(`select * from app.grants where status='pending' order by requested_at desc`)
    : { rows: [] as typeof mine.rows };

  const enriched = (rows: typeof mine.rows) => rows.map((g) => ({
    ...g,
    collectionType: cfg.collections[g.collection]?.type || "dataset",
    taxonomyField: cfg.collections[g.collection]?.taxonomy ?? null,
  }));

  return Response.json({ mine: enriched(mine.rows), pending: enriched(pending.rows) });
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/me-grants.integration.test.ts
```

Expected: PASS, 7/7.

- [ ] **Step 6: Build the member page**

Create `mvp/apps/web/app/member/MyGrants.tsx`:

```tsx
"use client";
import useSWRLike from "react";
import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/common/DataTable";
import { EmptyState } from "@/components/common/EmptyState";
import { StatusBadge, type GrantStatus } from "@/components/common/StatusBadge";
import { Mono } from "@/components/common/Mono";

type MeGrant = {
  id: string; collection: string; env: "dev" | "live";
  status: string; effectiveStatus: GrantStatus;
  allowed_fields: string[] | null; purpose_label: string | null;
  requested_at: string; expires_at: string | null;
  document_filter: { field: string; op: string; value: unknown } | null;
};

const columns: ColumnDef<MeGrant, unknown>[] = [
  { accessorKey: "collection", header: "Collection",
    cell: ({ row }) => <span className="font-medium">{row.original.collection}</span> },
  { accessorKey: "env", header: "Env",
    cell: ({ row }) => <Mono>{row.original.env}</Mono> },
  { accessorKey: "effectiveStatus", header: "Status",
    cell: ({ row }) => <StatusBadge status={row.original.effectiveStatus} /> },
  { accessorKey: "allowed_fields", header: "Fields",
    cell: ({ row }) => (
      <Mono className="text-muted-foreground">
        {(row.original.allowed_fields ?? []).join(", ") || "—"}
      </Mono>
    ) },
  { id: "scope", header: "Document scope",
    cell: ({ row }) => {
      const f = row.original.document_filter;
      if (!f) return <span className="text-xs text-muted-foreground">Whole collection</span>;
      return <Mono>{`${f.field} ${f.op} ${JSON.stringify(f.value)}`}</Mono>;
    } },
  { accessorKey: "expires_at", header: "Expires",
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.expires_at ? new Date(row.original.expires_at).toLocaleString() : "No expiry"}
      </span>
    ) },
];

export function MyGrants() {
  const [grants, setGrants] = useState<MeGrant[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/me/grants")
      .then((r) => r.json())
      .then((d) => setGrants(d.grants ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <DataTable
      columns={columns} data={grants} loading={loading}
      empty={
        <EmptyState
          icon={KeyRound}
          title="No grants yet"
          description="Access is deny-by-default. Request a grant on a collection to start querying it."
        />
      }
    />
  );
}
```

Delete the stray `import useSWRLike from "react";` line — it is not used (it is here only as a reminder that this file does its own fetching; remove it before committing).

Replace `mvp/apps/web/app/member/page.tsx`:

```tsx
import { PageHeader } from "@/components/common/PageHeader";
import { MyGrants } from "./MyGrants";

export default function MemberPage() {
  return (
    <>
      <PageHeader
        title="My grants"
        description="Access is deny-by-default: a collection is invisible until a grant covers it, and every grant is evaluated at query time."
      />
      <MyGrants />
    </>
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/api/me apps/web/app/member apps/web/app/api/grants/route.ts \
  apps/web/test/me-grants.integration.test.ts
git commit -m "feat(web): member my-grants surface; stop leaking the pending queue to members"
```

---

## Task 7: Member — request access (fixing the dead `request` branch)

**Files:**
- Modify: `mvp/apps/web/app/api/grants/route.ts` (implement `action: "request"`)
- Create: `mvp/apps/web/app/api/me/collections/route.ts`, `mvp/apps/web/app/member/RequestAccessSheet.tsx`
- Test: `mvp/apps/web/test/grant-request.integration.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/grants` with `{ action: "request", collection, purposeLabel, purposeDetail?, fields? }` → `{ ok: true, requestId }`
  - `GET /api/me/collections` → `{ collections: { name, description, type, grantableFields, alreadyGranted }[] }`
- Consumes: `requestGrant` and `grantableFields` from `@warehousd/broker`, `requireSession`, `readEnvCookie`.

**Background:** the current `action === "request"` branch is an empty `if` with a comment claiming the work happens "elsewhere in the grants flow". It does not — `requestGrant` is only reachable through the MCP `request_access` tool. A member using the web UI has no way to ask for anything.

- [ ] **Step 1: Write the failing test**

Create `mvp/apps/web/test/grant-request.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let miaCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("grantreq");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
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

describe("POST /api/grants action=request", () => {
  it("creates a pending grant owned by the session user", async () => {
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req("/api/grants", {
      method: "POST", cookie: miaCookie,
      body: { action: "request", collection: "departments",
              purposeLabel: "org chart", fields: ["id", "name"] },
    }) as any);
    expect(res.status).toBe(200);
    const { requestId } = await res.json();
    const row = await getAppPool().query(`select * from app.grants where id=$1`, [requestId]);
    expect(row.rows[0]).toMatchObject({
      status: "pending", user_id: "mia", collection: "departments",
      env: "dev", allowed_fields: ["id", "name"], purpose_label: "org chart",
    });
  });

  it("ignores a planted userId in the body", async () => {
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req("/api/grants", {
      method: "POST", cookie: miaCookie,
      body: { action: "request", collection: "metrics", purposeLabel: "kpi",
              userId: "ana", user_id: "ana" },
    }) as any);
    const { requestId } = await res.json();
    const row = await getAppPool().query(`select user_id from app.grants where id=$1`, [requestId]);
    expect(row.rows[0].user_id).toBe("mia");
  });

  it("rejects an unknown collection", async () => {
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req("/api/grants", {
      method: "POST", cookie: miaCookie,
      body: { action: "request", collection: "does_not_exist", purposeLabel: "x" },
    }) as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown_collection");
  });

  it("rejects a field the YAML marks posture:deny — the two-tier deny holds at request time", async () => {
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req("/api/grants", {
      method: "POST", cookie: miaCookie,
      body: { action: "request", collection: "people", purposeLabel: "directory",
              fields: ["id", "home_address"] },
    }) as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("field_not_grantable");
  });

  it("requires a purpose label", async () => {
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req("/api/grants", {
      method: "POST", cookie: miaCookie,
      body: { action: "request", collection: "metrics" },
    }) as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("purpose_required");
  });

  it("defaults to every grantable field when fields are omitted", async () => {
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req("/api/grants", {
      method: "POST", cookie: miaCookie,
      body: { action: "request", collection: "salaries", purposeLabel: "benchmarking" },
    }) as any);
    const { requestId } = await res.json();
    const row = await getAppPool().query(`select allowed_fields from app.grants where id=$1`, [requestId]);
    expect(row.rows[0].allowed_fields).not.toContain("ssn");
    expect(row.rows[0].allowed_fields.length).toBeGreaterThan(0);
  });
});

describe("GET /api/me/collections", () => {
  it("lists names, descriptions and grantable fields, never denied fields", async () => {
    const { GET } = await import("../app/api/me/collections/route");
    const body = await (await GET(req("/api/me/collections", { cookie: miaCookie }) as any)).json();
    const people = body.collections.find((c: any) => c.name === "people");
    expect(people.grantableFields).toContain("full_name");
    expect(people.grantableFields).not.toContain("home_address");
    expect(people.description).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/grant-request.integration.test.ts
```

Expected: FAIL on all seven.

- [ ] **Step 3: Implement `action: "request"`**

In `mvp/apps/web/app/api/grants/route.ts`, replace the whole `POST` handler. Add `requestGrant` and `grantableFields` to the `@warehousd/broker` import and `readEnvCookie` to the session import:

```ts
export async function POST(req: NextRequest) {
  const guard = await requireSession(req);
  if (!guard.ok) return guard.response;
  const user = guard.user;
  const body = await req.json();
  const { action } = body;
  const app = getAppPool();
  const cfg = loadConfig(projectDir);

  if (action === "request") {
    // Any authenticated user may ask. Requester and env come from the session and the signed
    // cookie — a userId or env in the body is never read.
    const { collection, purposeLabel, purposeDetail, fields } = body;
    const c = cfg.collections[collection];
    if (!c) return Response.json({ error: "unknown_collection" }, { status: 400 });
    if (typeof purposeLabel !== "string" || !purposeLabel.trim())
      return Response.json({ error: "purpose_required" }, { status: 400 });

    const grantable = grantableFields(cfg, collection);
    const requested: string[] = Array.isArray(fields) && fields.length ? fields : grantable;
    // Two-tier deny (§5.3): a posture:deny field can never be granted, so it can never even
    // be requested. Refusing here keeps unaskable fields out of the approver's inbox.
    for (const f of requested)
      if (!grantable.includes(f))
        return Response.json({ error: "field_not_grantable" }, { status: 400 });

    const requestId = await requestGrant(app, {
      userId: user.id,
      collection,
      env: readEnvCookie(req),
      purposeLabel: purposeLabel.trim(),
      purposeDetail: typeof purposeDetail === "string" ? purposeDetail.trim() : undefined,
      allowedFields: requested,
    });
    return Response.json({ ok: true, requestId });
  }

  // approve/deny/revoke are privileged.
  const priv = await requireRole(req, "manager");
  if (!priv.ok) return priv.response;
  const by = user.id; // decided_by comes from the session, never the request body

  if (action === "approve") return approve(app, cfg, body, by);
  if (action === "deny") { await denyGrant(app, body.id, by); return Response.json({ ok: true }); }
  if (action === "revoke") { await revokeGrant(app, body.id, by); return Response.json({ ok: true }); }
  return Response.json({ error: "unknown_action" }, { status: 400 });
}
```

`approve()` is a placeholder name for now — Task 9 defines it. Until then, temporarily inline the existing approve logic verbatim (including the `rowFilter` bug) so this task changes only the request path:

```ts
  if (action === "approve") {
    const opts: any = { allowedFields: body.allowedFields, expiresAt: body.expiresAt };
    if (body.selectedPaths && body.selectedPaths.length > 0)
      opts.rowFilter = { field: "path", op: "in", value: body.selectedPaths };
    await approveGrant(app, body.id, by, opts);
    return Response.json({ ok: true });
  }
```

Task 9 replaces exactly this block. Do not fix it here — the fix has its own failing test.

- [ ] **Step 4: Implement `GET /api/me/collections`**

Create `mvp/apps/web/app/api/me/collections/route.ts`:

```ts
import { NextRequest } from "next/server";
import { loadConfig, grantableFields } from "@warehousd/broker";
import { getAppPool } from "../../../lib/broker";
import { requireSession } from "../../../../lib/authz";
import { readEnvCookie } from "../../../../lib/session";

const projectDir = process.env.WAREHOUSD_PROJECT_DIR!;

// Mirrors broker.listCollections' disclosure rule (§10 test 2): names + descriptions are
// public to any authenticated user, and so is the YAML allow-list, because a user must know
// what they can ask for. Row counts, schemas of denied fields and data never appear here.
export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if (!guard.ok) return guard.response;
  const env = readEnvCookie(req);
  const cfg = loadConfig(projectDir);
  const existing = await getAppPool().query(
    `select collection from app.grants
     where user_id=$1 and env=$2 and status in ('pending','approved')`,
    [guard.user.id, env]);
  const taken = new Set(existing.rows.map((r) => r.collection));

  return Response.json({
    collections: Object.entries(cfg.collections).map(([name, c]) => ({
      name,
      description: c.description,
      type: c.type ?? "dataset",
      grantableFields: grantableFields(cfg, name),
      alreadyGranted: taken.has(name),
    })),
  });
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/grant-request.integration.test.ts
```

Expected: PASS, 7/7.

- [ ] **Step 6: Build the request sheet**

Create `mvp/apps/web/app/member/RequestAccessSheet.tsx`. A form goes in a `Sheet`, not a `Dialog` (`building-product-ui`):

```tsx
"use client";
import { useEffect, useState } from "react";
import { Plus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger,
} from "@/components/ui/sheet";

type Coll = {
  name: string; description: string; type: string;
  grantableFields: string[]; alreadyGranted: boolean;
};

export function RequestAccessSheet({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [colls, setColls] = useState<Coll[]>([]);
  const [collection, setCollection] = useState("");
  const [purposeLabel, setPurposeLabel] = useState("");
  const [purposeDetail, setPurposeDetail] = useState("");
  const [fields, setFields] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch("/api/me/collections").then((r) => r.json()).then((d) => setColls(d.collections ?? []));
  }, [open]);

  const selected = colls.find((c) => c.name === collection);

  useEffect(() => {
    setFields(new Set(selected?.grantableFields ?? []));
  }, [collection]);

  async function submit() {
    setSubmitting(true);
    const res = await fetch("/api/grants", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "request", collection, purposeLabel, purposeDetail,
        fields: Array.from(fields),
      }),
    });
    setSubmitting(false);
    if (!res.ok) { toast.error("Request failed", { description: (await res.json()).error }); return; }
    toast.success("Access requested", { description: "A manager will review it." });
    setOpen(false); setCollection(""); setPurposeLabel(""); setPurposeDetail("");
    onDone();
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button><Plus size={16} className="mr-2" />Request access</Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Request access</SheetTitle>
          <SheetDescription>
            State what you need the data for. Purpose is stamped on every audit event this
            grant produces.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-4">
          <div className="space-y-2">
            <Label htmlFor="collection">Collection <span className="text-destructive">*</span></Label>
            <Select value={collection} onValueChange={setCollection}>
              <SelectTrigger id="collection"><SelectValue placeholder="Pick a collection" /></SelectTrigger>
              <SelectContent>
                {colls.map((c) => (
                  <SelectItem key={c.name} value={c.name} disabled={c.alreadyGranted}>
                    {c.name}{c.alreadyGranted ? " — already requested" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected && <p className="text-xs text-muted-foreground">{selected.description}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="purpose">Purpose <span className="text-destructive">*</span></Label>
            <Input id="purpose" placeholder="onboarding prep"
              value={purposeLabel} onChange={(e) => setPurposeLabel(e.target.value)} />
            <p className="text-xs text-muted-foreground">A short label. Shown to your approver.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="detail">Detail</Label>
            <Textarea id="detail" rows={3}
              value={purposeDetail} onChange={(e) => setPurposeDetail(e.target.value)} />
          </div>

          {selected && (
            <div className="space-y-2">
              <Label>Fields</Label>
              <p className="text-xs text-muted-foreground">
                Only fields the configuration allows are listed. Your approver can trim this
                further, never widen it.
              </p>
              <div className="space-y-1.5 rounded-md border p-3">
                {selected.grantableFields.map((f) => (
                  <label key={f} className="flex items-center gap-2 font-mono text-xs">
                    <Checkbox
                      checked={fields.has(f)}
                      onCheckedChange={(v) => {
                        const next = new Set(fields);
                        if (v) next.add(f); else next.delete(f);
                        setFields(next);
                      }}
                    />
                    {f}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <SheetFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={submitting || !collection || !purposeLabel.trim() || fields.size === 0}
          >
            {submitting && <Loader2 size={16} className="mr-2 animate-spin" />}
            Submit request
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
```

Wire it into `MyGrants.tsx`: lift the fetch into a `load()` callback, render `<RequestAccessSheet onDone={load} />` as the `PageHeader` action in `app/member/page.tsx`. Because `page.tsx` is a server component and the sheet is a client component, move the `PageHeader` + sheet + table into a single client component `app/member/MemberHome.tsx` and have `page.tsx` render just that.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/api/grants/route.ts apps/web/app/api/me/collections \
  apps/web/app/member apps/web/test/grant-request.integration.test.ts
git commit -m "feat(web): members can request access from the UI; validate purpose and postures"
```

---

## Task 8: Member — how to connect

**Files:**
- Create: `mvp/apps/web/app/api/connect-info/route.ts`, `mvp/apps/web/app/member/connect/page.tsx`, `mvp/apps/web/app/member/connect/ConnectGuide.tsx`
- Test: `mvp/apps/web/test/connect-info.integration.test.ts`

**Interfaces:**
- Produces: `GET /api/connect-info` → `{ mcpUrl, apiUrl, issuer, scopes: string[], ssoProviders: { providerId, type }[], localLoginEnabled }`.
- Consumes: `requireSession`, `LOCAL_LOGIN_DISABLED` from `lib/auth.ts`.

- [ ] **Step 1: Write the failing test**

Create `mvp/apps/web/test/connect-info.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let miaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("connectinfo");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

function req(cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  return new Request("http://localhost:8722/api/connect-info", { headers });
}

describe("GET /api/connect-info", () => {
  it("401s without a session", async () => {
    const { GET } = await import("../app/api/connect-info/route");
    expect((await GET(req() as any)).status).toBe(401);
  });

  it("returns the MCP endpoint derived from BETTER_AUTH_URL, never from the request", async () => {
    const { GET } = await import("../app/api/connect-info/route");
    const body = await (await GET(req(miaCookie) as any)).json();
    expect(body.mcpUrl).toBe(`${process.env.BETTER_AUTH_URL}/mcp`);
    expect(body.scopes).toEqual(["env:dev", "env:live"]);
  });

  it("never returns a client secret or a token", async () => {
    const { GET } = await import("../app/api/connect-info/route");
    const raw = await (await GET(req(miaCookie) as any)).text();
    expect(raw).not.toMatch(/secret/i);
    expect(raw).not.toMatch(/access_token/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/connect-info.integration.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `mvp/apps/web/app/api/connect-info/route.ts`:

```ts
import { NextRequest } from "next/server";
import { getAppPool } from "../../lib/broker";
import { requireSession } from "../../../lib/authz";
import { LOCAL_LOGIN_DISABLED } from "../../../lib/auth";

// The base URL is the configured issuer, never a Host header — a connector URL derived from
// an attacker-controlled header would send users' OAuth flows somewhere else.
const BASE = process.env.BETTER_AUTH_URL ?? "http://localhost:8722";

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if (!guard.ok) return guard.response;
  const r = await getAppPool().query(
    `select "providerId", "samlConfig" from app."ssoProvider"`);
  return Response.json({
    mcpUrl: `${BASE}/mcp`,
    apiUrl: BASE,
    issuer: BASE,
    scopes: ["env:dev", "env:live"],
    ssoProviders: r.rows.map((x) => ({
      providerId: x.providerId, type: x.samlConfig ? "saml" : "oidc",
    })),
    localLoginEnabled: !LOCAL_LOGIN_DISABLED,
  });
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/connect-info.integration.test.ts
```

Expected: PASS, 3/3.

- [ ] **Step 5: Build the guide**

Create `mvp/apps/web/app/member/connect/ConnectGuide.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Mono } from "@/components/common/Mono";
import { Skeleton } from "@/components/ui/skeleton";

type Info = { mcpUrl: string; scopes: string[]; ssoProviders: { providerId: string }[] };

export function ConnectGuide() {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => { fetch("/api/connect-info").then((r) => r.json()).then(setInfo); }, []);
  if (!info) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="max-w-2xl space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-sm font-medium">Your MCP endpoint</CardTitle></CardHeader>
        <CardContent>
          <Mono copyable className="text-sm">{info.mcpUrl}</Mono>
          <p className="mt-2 text-sm text-muted-foreground">
            Paste this into Claude&rsquo;s connector settings. Authentication happens over
            OAuth — you never enter a password or a token here.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm font-medium">Steps</CardTitle></CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>In Claude, open <b>Settings → Connectors → Add custom connector</b>.</li>
            <li>Paste the endpoint above and continue.</li>
            <li>
              You&rsquo;ll be sent here to sign in
              {info.ssoProviders.length > 0
                ? " with your organisation account."
                : " with your warehousd credentials."}
            </li>
            <li>
              Approve the connection. If you have approved live grants you&rsquo;ll be asked to
              pick an environment — <Mono>dev</Mono> uses synthetic data, <Mono>live</Mono> uses
              real data.
            </li>
            <li>
              Ask Claude to <i>list the collections it can see</i>. Anything you have no grant
              for stays invisible.
            </li>
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm font-medium">What Claude can and cannot do</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Claude proposes queries; the broker re-validates every one of them against your
            grants before any SQL is built. Fields you have no grant for are never selected,
            so they cannot appear in an answer — not even in an error message.
          </p>
          <p>
            Every call, allowed or refused, is written to the audit log with your identity,
            the environment, and the purpose on your grant.
          </p>
          <p>Claude cannot write, update or delete anything. The MCP surface is read plus access-request only.</p>
        </CardContent>
      </Card>
    </div>
  );
}
```

Create `mvp/apps/web/app/member/connect/page.tsx`:

```tsx
import { PageHeader } from "@/components/common/PageHeader";
import { ConnectGuide } from "./ConnectGuide";

export default function ConnectPage() {
  return (
    <>
      <PageHeader
        title="How to connect"
        description="Point an MCP client at this deployment. Your grants travel with your identity, not with the client."
      />
      <ConnectGuide />
    </>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/api/connect-info apps/web/app/member/connect \
  apps/web/test/connect-info.integration.test.ts
git commit -m "feat(web): member how-to-connect surface with the MCP endpoint"
```

---

## Task 9: Fix the silently-dropped document filter on approval

**Files:**
- Create: `mvp/apps/web/lib/approve.ts`
- Modify: `mvp/apps/web/app/api/grants/route.ts` (approve branch)
- Test: `mvp/apps/web/test/grant-approve.integration.test.ts`

**Interfaces:**
- Produces: `buildApproval(cfg, requested, input): { ok: true; opts: ApproveOpts } | { ok: false; error: string }` from `lib/approve.ts`, where
  `ApproveOpts = { allowedFields?: string[]; expiresAt?: string; documentFilter?: { field: string; op: "in"; value: string[] } }`.
- Consumes: `grantableFields`, `WarehousdConfig`.

**Background — this is a live security defect.** `app/api/grants/route.ts:47` writes the scoping predicate to `opts.rowFilter`; `approveGrant` (`packages/broker/src/grants/manage.ts:16`) reads `opts.documentFilter`. The key does not exist on the options object, so `document_filter` is persisted as `NULL` and **a manager who scopes an approval to two specific policy files actually grants the whole collection.** The taxonomy path is worse: `Grants.tsx` sends `selectedTerms`, and the route never destructures it at all.

The name `rowFilter` is the pre-rename spelling from before the Collection/Document terminology unification (commit `ec2f243`) — the broker was renamed, this call site was not.

- [ ] **Step 1: Write the failing test**

Create `mvp/apps/web/test/grant-approve.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let marcusCookie: string, miaCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("grantapprove");
  marcusCookie = await signIn(db.auth, "marcus@meridian.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

function req(body: unknown, cookie: string) {
  return new Request("http://localhost:8722/api/grants", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function pending(user: string, collection: string, fields: string[], env = "dev") {
  const r = await getAppPool().query(
    `insert into app.grants (user_id,collection,env,status,allowed_fields,purpose_label)
     values ($1,$2,$3,'pending',$4,'test') returning id`,
    [user, collection, env, fields]);
  return r.rows[0].id as string;
}

async function grantRow(id: string) {
  const r = await getAppPool().query(`select * from app.grants where id=$1`, [id]);
  return r.rows[0];
}

describe("approve — document scoping actually persists", () => {
  it("path selection lands in document_filter, not a dropped key", async () => {
    const id = await pending("mia", "policies", ["title", "content"], "live");
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({
      action: "approve", id, allowedFields: ["title", "content"],
      selectedPaths: ["security.md"],
    }, marcusCookie) as any);
    expect(res.status).toBe(200);
    const g = await grantRow(id);
    expect(g.status).toBe("approved");
    expect(g.document_filter).toEqual({ field: "path", op: "in", value: ["security.md"] });
  });

  it("term selection lands in document_filter on the taxonomy field", async () => {
    const id = await pending("marcus", "policies", ["title", "content"], "live");
    const { POST } = await import("../app/api/grants/route");
    await POST(req({
      action: "approve", id, allowedFields: ["title", "content"],
      selectedTerms: ["hr", "benefits"],
    }, marcusCookie) as any);
    const g = await grantRow(id);
    expect(g.document_filter).toEqual({ field: "category", op: "in", value: ["hr", "benefits"] });
  });

  it("terms win over paths when both are sent", async () => {
    const id = await pending("mia", "policies", ["title"], "dev");
    const { POST } = await import("../app/api/grants/route");
    await POST(req({
      action: "approve", id, allowedFields: ["title"],
      selectedPaths: ["hr/pto.md"], selectedTerms: ["finance"],
    }, marcusCookie) as any);
    const g = await grantRow(id);
    expect(g.document_filter.field).toBe("category");
  });

  it("no selection leaves document_filter null (whole collection)", async () => {
    const id = await pending("marcus", "announcements", ["id", "title"]);
    const { POST } = await import("../app/api/grants/route");
    await POST(req({ action: "approve", id, allowedFields: ["id", "title"] }, marcusCookie) as any);
    const g = await grantRow(id);
    expect(g.document_filter).toBeNull();
  });

  it("a client-supplied filter field is ignored — the field comes from the config", async () => {
    const id = await pending("mia", "policies", ["title"], "dev");
    const { POST } = await import("../app/api/grants/route");
    await POST(req({
      action: "approve", id, allowedFields: ["title"],
      selectedTerms: ["hr"],
      documentFilter: { field: "content", op: "in", value: ["anything"] }, // forged
    }, marcusCookie) as any);
    const g = await grantRow(id);
    expect(g.document_filter.field).toBe("category");
  });
});

describe("approve — field trimming", () => {
  it("trims to a subset of what was requested", async () => {
    const id = await pending("mia", "people", ["id", "full_name", "email"]);
    const { POST } = await import("../app/api/grants/route");
    await POST(req({ action: "approve", id, allowedFields: ["id", "full_name"] }, marcusCookie) as any);
    expect((await grantRow(id)).allowed_fields).toEqual(["id", "full_name"]);
  });

  it("refuses to widen beyond what was requested", async () => {
    const id = await pending("marcus", "people", ["id"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({
      action: "approve", id, allowedFields: ["id", "email"],
    }, marcusCookie) as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("cannot_widen");
    expect((await grantRow(id)).status).toBe("pending");
  });

  it("refuses a posture:deny field even if it somehow reached the request", async () => {
    const id = await pending("mia", "people", ["id", "home_address"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({
      action: "approve", id, allowedFields: ["id", "home_address"],
    }, marcusCookie) as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("field_not_grantable");
  });
});

describe("approve — expiry", () => {
  it("persists a future expiry", async () => {
    const id = await pending("marcus", "metrics", ["id", "date"]);
    const when = new Date(Date.now() + 86_400_000).toISOString();
    const { POST } = await import("../app/api/grants/route");
    await POST(req({ action: "approve", id, allowedFields: ["id", "date"], expiresAt: when }, marcusCookie) as any);
    expect(new Date((await grantRow(id)).expires_at).toISOString()).toBe(when);
  });

  it("refuses an expiry in the past", async () => {
    const id = await pending("mia", "metrics", ["id"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({
      action: "approve", id, allowedFields: ["id"],
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }, marcusCookie) as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("expiry_in_past");
  });

  it("refuses an unparseable expiry", async () => {
    const id = await pending("mia", "metrics", ["id"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({
      action: "approve", id, allowedFields: ["id"], expiresAt: "next tuesday",
    }, marcusCookie) as any);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_expiry");
  });
});

describe("approve — role", () => {
  it("a member cannot approve", async () => {
    const id = await pending("marcus", "metrics", ["id"]);
    const { POST } = await import("../app/api/grants/route");
    const res = await POST(req({ action: "approve", id, allowedFields: ["id"] }, miaCookie) as any);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/grant-approve.integration.test.ts
```

Expected: the two document-scoping tests fail with `document_filter` = `null` (the bug), the widen/expiry tests fail because no validation exists.

- [ ] **Step 3: Implement `buildApproval`**

Create `mvp/apps/web/lib/approve.ts`:

```ts
import { grantableFields, type WarehousdConfig } from "@warehousd/broker";

export type ApproveOpts = {
  allowedFields?: string[];
  expiresAt?: string;
  documentFilter?: { field: string; op: "in"; value: string[] };
};

export type ApprovalInput = {
  collection: string;
  allowedFields?: unknown;
  expiresAt?: unknown;
  selectedPaths?: unknown;
  selectedTerms?: unknown;
};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

// Turns an approver's form submission into approveGrant options, or a reason code.
//
// The document_filter FIELD is derived from the YAML config, never from the request: the
// approver picks values (which paths, which terms), the server decides which column those
// values gate. A forged `documentFilter` in the body is ignored outright — §5.6.4 requires
// the predicate to be author-supplied, and "author" here means this function.
export function buildApproval(
  cfg: WarehousdConfig,
  requestedFields: string[],
  input: ApprovalInput,
): { ok: true; opts: ApproveOpts } | { ok: false; error: string } {
  const c = cfg.collections[input.collection];
  if (!c) return { ok: false, error: "unknown_collection" };

  const grantable = grantableFields(cfg, input.collection);
  const approved = strings(input.allowedFields);
  if (approved.length === 0) return { ok: false, error: "no_fields" };
  for (const f of approved) {
    if (!grantable.includes(f)) return { ok: false, error: "field_not_grantable" };
    // An approver trims, never widens. Widening would let a manager hand out access the
    // requester never asked for and never stated a purpose for.
    if (!requestedFields.includes(f)) return { ok: false, error: "cannot_widen" };
  }

  const opts: ApproveOpts = { allowedFields: approved };

  if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== "") {
    if (typeof input.expiresAt !== "string") return { ok: false, error: "invalid_expiry" };
    const t = Date.parse(input.expiresAt);
    if (Number.isNaN(t)) return { ok: false, error: "invalid_expiry" };
    if (t <= Date.now()) return { ok: false, error: "expiry_in_past" };
    opts.expiresAt = new Date(t).toISOString();
  }

  // Terms take precedence over paths: a term scope is the coarser, intentional choice, and
  // approving with both selected would otherwise silently drop one of them.
  const terms = strings(input.selectedTerms);
  const paths = strings(input.selectedPaths);
  if (terms.length > 0 && c.taxonomy) {
    opts.documentFilter = { field: c.taxonomy, op: "in", value: terms };
  } else if (paths.length > 0 && c.type === "file") {
    opts.documentFilter = { field: "path", op: "in", value: paths };
  }

  return { ok: true, opts };
}
```

- [ ] **Step 4: Wire it into the route**

In `mvp/apps/web/app/api/grants/route.ts`, replace the temporary approve block from Task 7 Step 3 with:

```ts
  if (action === "approve") {
    const cur = await app.query(
      `select collection, allowed_fields, status from app.grants where id=$1`, [body.id]);
    const row = cur.rows[0];
    if (!row) return Response.json({ error: "unknown_grant" }, { status: 404 });
    if (row.status !== "pending") return Response.json({ error: "not_pending" }, { status: 409 });

    const built = buildApproval(cfg, row.allowed_fields ?? [], {
      collection: row.collection,
      allowedFields: body.allowedFields,
      expiresAt: body.expiresAt,
      selectedPaths: body.selectedPaths,
      selectedTerms: body.selectedTerms,
    });
    if (!built.ok) return Response.json({ error: built.error }, { status: 400 });

    await approveGrant(app, body.id, by, built.opts);
    return Response.json({ ok: true });
  }
```

Add `import { buildApproval } from "../../../lib/approve";` at the top.

- [ ] **Step 5: Run it and watch it pass**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/grant-approve.integration.test.ts
```

Expected: PASS, 12/12.

- [ ] **Step 6: Prove the fix at the broker layer too**

The predicate must actually restrict documents, not merely be stored. Run the existing suites that exercise `documentFilter` end to end:

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run \
  packages/broker/test/taxonomy-grants.test.ts \
  packages/broker/test/search-documents.test.ts \
  packages/broker/test/grant-lifecycle.test.ts
```

Expected: all green (they were green before — this confirms the route now feeds the broker the shape it already handles correctly).

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/approve.ts apps/web/app/api/grants/route.ts \
  apps/web/test/grant-approve.integration.test.ts
git commit -m "fix(web): approvals dropped document_filter (rowFilter key never read by approveGrant)"
```

---

## Task 10: Manager — grant inbox and the approval sheet

**Files:**
- Create: `mvp/packages/broker/src/documents/paths.ts`, `mvp/apps/web/app/manager/Inbox.tsx`, `mvp/apps/web/app/manager/ApproveSheet.tsx`
- Modify: `mvp/packages/broker/src/index.ts`, `mvp/apps/web/app/api/grants/doc-paths/route.ts`, `mvp/apps/web/app/manager/page.tsx`
- Test: `mvp/packages/broker/test/document-paths.test.ts`

**Interfaces:**
- Produces: `listDocumentPaths(pools: Pools, env: "dev"|"live", cfg: WarehousdConfig, collection: string): Promise<string[]>` exported from `@warehousd/broker`.
- Consumes: `dataPool`, `WarehousdConfig`.

**Background:** `app/api/grants/doc-paths/route.ts` currently runs `select path from data_synth."policies__files"` on the **app pool**, straight from a route file. That breaks invariant 1 (broker-only data path) twice over: a non-broker code path reads a data schema, and it does so with the owner role rather than the env-scoped role. Move it into the broker where it belongs.

- [ ] **Step 1: Write the failing test**

Create `mvp/packages/broker/test/document-paths.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import {
  createAppSchema, applyConfig, createPools, indexCollection, type Pools,
} from "../src/index";
import { loadConfig } from "../src/config/load";
import { listDocumentPaths } from "../src/documents/paths";

let p: Provisioned, admin: Pool, pools: Pools;
const meridian = new URL("../../../examples/meridian", import.meta.url).pathname;
const cfg = loadConfig(meridian);

beforeAll(async () => {
  p = await provision("docpaths");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  await indexCollection(admin, "dev", "policies", `${meridian}/seed/docs-dev`, {
    taxonomy: { field: "category", slugs: Object.keys(cfg.taxonomies.category?.terms ?? {}) },
  });
  await indexCollection(admin, "live", "policies", `${meridian}/seed/docs-live`, {
    taxonomy: { field: "category", slugs: Object.keys(cfg.taxonomies.category?.terms ?? {}) },
  });
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
}, 60_000);

afterAll(async () => { await admin.end(); await pools.end(); await p.end(); });

describe("listDocumentPaths", () => {
  it("returns the dev source paths on the dev pool", async () => {
    const paths = await listDocumentPaths(pools, "dev", cfg, "policies");
    expect(paths).toContain("remote-work.md");
    expect(paths.length).toBeGreaterThan(0);
  });

  it("returns different paths for live — the env wall holds", async () => {
    const dev = await listDocumentPaths(pools, "dev", cfg, "policies");
    const live = await listDocumentPaths(pools, "live", cfg, "policies");
    expect(live).not.toEqual(dev);
    expect(live).toContain("security.md");
    expect(dev).not.toContain("security.md");
  });

  it("throws on a dataset collection rather than guessing a table name", async () => {
    await expect(listDocumentPaths(pools, "dev", cfg, "people")).rejects.toThrow(/not a file collection/);
  });

  it("throws on an unknown collection", async () => {
    await expect(listDocumentPaths(pools, "dev", cfg, "nope")).rejects.toThrow(/Unknown collection/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd mvp && npx vitest run packages/broker/test/document-paths.test.ts
```

Expected: FAIL — cannot resolve `../src/documents/paths`.

- [ ] **Step 3: Implement**

Create `mvp/packages/broker/src/documents/paths.ts`:

```ts
import type { WarehousdConfig } from "../config/schema";
import { dataPool, type Pools } from "../db/pools";

// The approver's path picker needs the set of indexed files for a collection. It reads
// through the env-scoped pool like every other data read — a route must never query a data
// schema directly (invariant 1).
//
// `path` is usually posture:deny (it gates documents without being readable). That is fine
// here: this is grant-authoring metadata shown to an approver, not query output returned to
// a grantee, and the values never enter a BrokerResult.
export async function listDocumentPaths(
  pools: Pools, env: "dev" | "live", cfg: WarehousdConfig, collection: string,
): Promise<string[]> {
  const c = cfg.collections[collection];
  if (!c) throw new Error(`Unknown collection: ${collection}`);
  if (c.type !== "file") throw new Error(`Collection ${collection} is not a file collection`);
  const schema = env === "dev" ? "data_synth" : "data_live";
  // `collection` is validated against the loaded config above, so this identifier
  // interpolation is safe — SQL identifiers cannot be parameterized.
  const r = await dataPool(pools, { userId: "", env }).query(
    `select path from ${schema}.v_${collection} group by path order by path`);
  return r.rows.map((x) => x.path as string);
}
```

The view `v_policies` already exposes `path` and the env roles already hold `SELECT` on it (`grantViewDDL`), so no new privileges are needed. `group by path` collapses the one-row-per-document view to one row per file.

Add to `mvp/packages/broker/src/index.ts`:

```ts
export { listDocumentPaths } from "./documents/paths";
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd mvp && npx vitest run packages/broker/test/document-paths.test.ts
```

Expected: PASS, 4/4.

- [ ] **Step 5: Rewrite the route on top of it**

Replace `mvp/apps/web/app/api/grants/doc-paths/route.ts` entirely:

```ts
import { NextRequest } from "next/server";
import { loadConfig, listDocumentPaths } from "@warehousd/broker";
import { getBroker } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";

const projectDir = process.env.WAREHOUSD_PROJECT_DIR!;

// Grant-authoring metadata: approvers only.
export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "manager");
  if (!guard.ok) return guard.response;

  const collection = req.nextUrl.searchParams.get("collection") ?? "";
  const env = req.nextUrl.searchParams.get("env");
  if (env !== "dev" && env !== "live")
    return Response.json({ error: "invalid_env" }, { status: 400 });

  try {
    const paths = await listDocumentPaths(getBroker().pools, env, loadConfig(projectDir), collection);
    return Response.json({ paths });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 400 });
  }
}
```

Note the deliberate change: `env` here is the env **of the grant being approved**, which is a legitimate query parameter — it selects which environment's file list to show, and it can only ever widen the approver's view to data they may already author grants over. It is *not* a BrokerContext env: `listDocumentPaths` builds its own `{userId:"", env}` for pool selection only. Add a comment saying exactly that above the handler so a future reader does not mistake it for an invariant violation.

Do the same role-gating on `mvp/apps/web/app/api/grants/terms/route.ts` — it currently has no session check at all (it is unmatched by the middleware because the matcher covers `/api/grants/:path*`… verify: `/api/grants/terms` **is** matched, so it is 401-gated, but not role-gated). Add `requireRole(req, "manager")`.

- [ ] **Step 6: Build the inbox**

Create `mvp/apps/web/app/manager/ApproveSheet.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Mono } from "@/components/common/Mono";

export type PendingGrant = {
  id: string; user_id: string; collection: string; env: "dev" | "live";
  allowed_fields: string[] | null; purpose_label: string | null; purpose_detail: string | null;
  requested_at: string; collectionType?: string; taxonomyField?: string | null;
};

export function ApproveSheet({
  grant, open, onOpenChange, onDone,
}: {
  grant: PendingGrant | null; open: boolean;
  onOpenChange: (v: boolean) => void; onDone: () => void;
}) {
  const [fields, setFields] = useState<Set<string>>(new Set());
  const [expiresAt, setExpiresAt] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [terms, setTerms] = useState<{ slug: string; label: string }[]>([]);
  const [pickedPaths, setPickedPaths] = useState<Set<string>>(new Set());
  const [pickedTerms, setPickedTerms] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!grant) return;
    setFields(new Set(grant.allowed_fields ?? []));
    setPickedPaths(new Set()); setPickedTerms(new Set());
    setExpiresAt(""); setPaths([]); setTerms([]);

    if (grant.collectionType === "file") {
      fetch(`/api/grants/doc-paths?collection=${grant.collection}&env=${grant.env}`)
        .then((r) => r.json()).then((d) => setPaths(d.paths ?? []));
    }
    if (grant.taxonomyField) {
      fetch(`/api/grants/terms?collection=${grant.collection}`)
        .then((r) => r.json()).then((d) => setTerms(d.terms ?? []));
    }
  }, [grant]);

  async function act(action: "approve" | "deny") {
    if (!grant) return;
    setBusy(true);
    const res = await fetch("/api/grants", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(
        action === "deny"
          ? { action, id: grant.id }
          : {
              action, id: grant.id,
              allowedFields: Array.from(fields),
              expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
              selectedPaths: Array.from(pickedPaths),
              selectedTerms: Array.from(pickedTerms),
            }),
    });
    setBusy(false);
    if (!res.ok) { toast.error("Failed", { description: (await res.json()).error }); return; }
    toast.success(action === "approve" ? "Grant approved" : "Request denied");
    onOpenChange(false); onDone();
  }

  if (!grant) return null;
  const scoped = pickedTerms.size > 0 || pickedPaths.size > 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Review request</SheetTitle>
          <SheetDescription>
            <Mono>{grant.user_id}</Mono> wants <Mono>{grant.collection}</Mono> in{" "}
            <Mono>{grant.env}</Mono>
            {grant.purpose_label ? <> for <b>{grant.purpose_label}</b></> : null}.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-4">
          {grant.purpose_detail && (
            <p className="rounded-md border bg-card p-3 text-sm text-muted-foreground">
              {grant.purpose_detail}
            </p>
          )}

          <div className="space-y-2">
            <Label>Fields</Label>
            <p className="text-xs text-muted-foreground">
              Uncheck to trim. You cannot add fields the requester did not ask for.
            </p>
            <div className="space-y-1.5 rounded-md border p-3">
              {(grant.allowed_fields ?? []).map((f) => (
                <label key={f} className="flex items-center gap-2 font-mono text-xs">
                  <Checkbox
                    checked={fields.has(f)}
                    onCheckedChange={(v) => {
                      const next = new Set(fields);
                      if (v) next.add(f); else next.delete(f);
                      setFields(next);
                    }}
                  />
                  {f}
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="expiry">Expires</Label>
            <Input id="expiry" type="datetime-local"
              value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              Leave empty for no expiry. An expired grant behaves exactly like a revoked one.
            </p>
          </div>

          {terms.length > 0 && (
            <div className="space-y-2">
              <Label>Categories</Label>
              <p className="text-xs text-muted-foreground">
                Restrict the grant to these categories. Overrides file selection.
              </p>
              <div className="space-y-1.5 rounded-md border p-3">
                {terms.map((t) => (
                  <label key={t.slug} className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={pickedTerms.has(t.slug)}
                      onCheckedChange={(v) => {
                        const next = new Set(pickedTerms);
                        if (v) next.add(t.slug); else next.delete(t.slug);
                        setPickedTerms(next);
                      }}
                    />
                    {t.label} <Mono className="text-muted-foreground">{t.slug}</Mono>
                  </label>
                ))}
              </div>
            </div>
          )}

          {paths.length > 0 && pickedTerms.size === 0 && (
            <div className="space-y-2">
              <Label>Files</Label>
              <div className="space-y-1.5 rounded-md border p-3">
                {paths.map((p) => (
                  <label key={p} className="flex items-center gap-2 font-mono text-xs">
                    <Checkbox
                      checked={pickedPaths.has(p)}
                      onCheckedChange={(v) => {
                        const next = new Set(pickedPaths);
                        if (v) next.add(p); else next.delete(p);
                        setPickedPaths(next);
                      }}
                    />
                    {p}
                  </label>
                ))}
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {scoped
              ? "This grant will be restricted to the selection above. Everything else is silently absent."
              : "No document restriction — this grant reaches the whole collection."}
          </p>
        </div>

        <SheetFooter>
          <Button variant="outline" disabled={busy} onClick={() => act("deny")}>Deny</Button>
          <Button disabled={busy || fields.size === 0} onClick={() => act("approve")}>
            {busy && <Loader2 size={16} className="mr-2 animate-spin" />}
            Approve
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
```

Create `mvp/apps/web/app/manager/Inbox.tsx` — a `DataTable` over `GET /api/grants`'s `pending` array with columns: requester (`Mono`), collection, env (`Mono`), purpose, requested-at, and a **Review** button that opens `ApproveSheet`. Empty state: `EmptyState` with `icon={Inbox}`, title "Nothing waiting", description "New access requests will appear here.".

Replace `mvp/apps/web/app/manager/page.tsx` to render `<PageHeader title="Grant inbox" …/>` plus `<Inbox />` (client component doing its own fetch, same pattern as `MyGrants`).

- [ ] **Step 7: Run the full web suite**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web
```

Expected: everything green, including the pre-existing `mcp-*` and `oauth-*` suites.

- [ ] **Step 8: Commit**

```bash
git add packages/broker/src/documents packages/broker/src/index.ts \
  packages/broker/test/document-paths.test.ts apps/web/app/api/grants \
  apps/web/app/manager
git commit -m "feat(web): manager grant inbox with trimming, expiry and document scoping"
```

---

## Task 11: Manager — active grants, revoke, and §10 test 7 end to end

**Files:**
- Create: `mvp/apps/web/app/manager/grants/page.tsx`, `mvp/apps/web/app/manager/grants/ActiveGrants.tsx`, `mvp/apps/web/test/grant-lifecycle-ui.integration.test.ts`
- Delete: `mvp/apps/web/app/components/Grants.tsx`
- Test: as above

**Interfaces:**
- Produces: the `/manager/grants` surface; `GET /api/grants` gains `?status=approved` filtering for the active list (implemented inside the existing handler).
- Consumes: `revokeGrant` (already imported by the route).

- [ ] **Step 1: Write the failing test — the acceptance gate**

Create `mvp/apps/web/test/grant-lifecycle-ui.integration.test.ts`. This is §10 test 7 driven entirely through the real HTTP handlers, with no direct `app.grants` writes anywhere in the arrange phase:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getBroker } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let miaCookie: string, marcusCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("lifecycleui");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

function post(body: unknown, cookie: string) {
  return new Request("http://localhost:8722/api/grants", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}
function get(url: string, cookie: string) {
  return new Request(`http://localhost:8722${url}`, { headers: { cookie } });
}

// §10 test 7, through the surface a human actually uses.
describe("grant lifecycle through the UI/API layer", () => {
  it("request → pending → approve trimmed with expiry → query works → revoke → immediate no_grant", async () => {
    const { POST, GET } = await import("../app/api/grants/route");
    const { broker } = getBroker();
    const ctx = { userId: "mia", env: "dev" as const };

    // 0. deny by default
    const before = await broker.query(ctx, { collection: "departments", fields: ["id", "name"] });
    expect(before.ok).toBe(false);
    if (before.ok) throw new Error("unreachable");
    expect(before.reason).toBe("no_grant");

    // 1. Mia requests two fields
    const reqRes = await POST(post({
      action: "request", collection: "departments",
      purposeLabel: "org chart", fields: ["id", "name"],
    }, miaCookie) as any);
    expect(reqRes.status).toBe(200);
    const { requestId } = await reqRes.json();

    // 2. it is pending, and it is in Marcus's inbox
    const inbox = await (await GET(get("/api/grants", marcusCookie) as any)).json();
    expect(inbox.pending.some((g: any) => g.id === requestId)).toBe(true);

    // 3. Marcus approves, trimming to one field and setting an expiry
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const okRes = await POST(post({
      action: "approve", id: requestId, allowedFields: ["name"], expiresAt,
    }, marcusCookie) as any);
    expect(okRes.status).toBe(200);

    // 4. the query now succeeds, and the trimmed field is absent — not null
    const allowed = await broker.query(ctx, { collection: "departments" });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) throw new Error("unreachable");
    expect(allowed.fieldsReturned).toEqual(["name"]);
    for (const row of allowed.documents) expect("id" in row).toBe(false);

    // 5. asking for the trimmed field explicitly is refused
    const denied = await broker.query(ctx, { collection: "departments", fields: ["id"] });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.reason).toBe("field_denied");

    // 6. Marcus revokes
    const revRes = await POST(post({ action: "revoke", id: requestId }, marcusCookie) as any);
    expect(revRes.status).toBe(200);

    // 7. the very next query is refused — no token refresh, no cache to wait on
    const after = await broker.query(ctx, { collection: "departments" });
    expect(after.ok).toBe(false);
    if (after.ok) throw new Error("unreachable");
    expect(after.reason).toBe("no_grant");
  });

  it("an expired grant behaves exactly like a revoked one", async () => {
    const { POST } = await import("../app/api/grants/route");
    const { broker } = getBroker();
    const ctx = { userId: "mia", env: "dev" as const };

    const { requestId } = await (await POST(post({
      action: "request", collection: "metrics", purposeLabel: "kpi", fields: ["id", "date"],
    }, miaCookie) as any)).json();
    const soon = new Date(Date.now() + 1_500).toISOString();
    await POST(post({
      action: "approve", id: requestId, allowedFields: ["id", "date"], expiresAt: soon,
    }, marcusCookie) as any);

    const live = await broker.query(ctx, { collection: "metrics" });
    expect(live.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 2_000));

    const dead = await broker.query(ctx, { collection: "metrics" });
    expect(dead.ok).toBe(false);
    if (dead.ok) throw new Error("unreachable");
    expect(dead.reason).toBe("no_grant");
  });

  it("a member cannot revoke someone else's grant", async () => {
    const { POST } = await import("../app/api/grants/route");
    const { requestId } = await (await POST(post({
      action: "request", collection: "announcements", purposeLabel: "newsletter",
    }, miaCookie) as any)).json();
    const res = await POST(post({ action: "revoke", id: requestId }, miaCookie) as any);
    expect(res.status).toBe(403);
  });

  it("every step above is audited", async () => {
    const { getAppPool } = await import("../app/lib/broker");
    const r = await getAppPool().query(
      `select outcome, reason, collection from app.audit_events
       where user_id='mia' and collection='departments' order by at asc`);
    const outcomes = r.rows.map((x) => `${x.outcome}:${x.reason ?? ""}`);
    expect(outcomes).toContain("refused:no_grant");
    expect(outcomes).toContain("allowed:");
    expect(outcomes).toContain("refused:field_denied");
  });
});
```

- [ ] **Step 2: Run it**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/grant-lifecycle-ui.integration.test.ts
```

Expected: PASS with no new production code — Tasks 7 and 9 already built everything this exercises. If any assertion fails, the failure is real and belongs to whichever of those tasks owns it; fix it there rather than weakening the assertion.

- [ ] **Step 3: Build the active-grants surface**

Create `mvp/apps/web/app/manager/grants/ActiveGrants.tsx`: a `DataTable` over `GET /api/grants` (use `mine` + `pending`? no — add a third array). Extend the `GET` handler in `app/api/grants/route.ts` to also return, for managers and admins only:

```ts
  const active = atLeast(user.role, "manager")
    ? await app.query(
        `select * from app.grants where status='approved' order by decided_at desc nulls last`)
    : { rows: [] as typeof mine.rows };
```

and include `active: enriched(active.rows)` in the response.

Columns: user (`Mono`), collection, env (`Mono`), fields (`Mono`, muted), document scope (same renderer as `MyGrants`), expires, and a **Revoke** action. Revoke is destructive and irreversible for that grant, so it goes behind `AlertDialog`:

```tsx
<AlertDialog>
  <AlertDialogTrigger asChild>
    <Button variant="destructive" size="sm">Revoke</Button>
  </AlertDialogTrigger>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Revoke {g.user_id}&rsquo;s access to {g.collection}?</AlertDialogTitle>
      <AlertDialogDescription>
        Revocation is immediate — their very next query is refused, with no token refresh
        involved. They can request access again.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction
        className="bg-destructive hover:bg-destructive/90"
        onClick={() => revoke(g.id)}
      >
        Revoke
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

Create `mvp/apps/web/app/manager/grants/page.tsx` rendering `<PageHeader title="Active grants" description="Every approved grant in this deployment. Revocation takes effect on the next query." />` plus `<ActiveGrants />`.

- [ ] **Step 4: Delete the superseded component**

```bash
cd mvp && git rm apps/web/app/components/Grants.tsx
grep -rn "components/Grants" apps/web --include="*.tsx" --include="*.ts" | grep -v node_modules
```

Expected: the grep returns nothing. If it returns a hit, that file still imports the deleted component — fix it before continuing.

- [ ] **Step 5: Full suite**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian pnpm test 2>&1 | tail -20
```

Expected: green, with strictly more tests than the Task 0 baseline.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/manager apps/web/app/api/grants/route.ts \
  apps/web/test/grant-lifecycle-ui.integration.test.ts
git rm --cached apps/web/app/components/Grants.tsx 2>/dev/null || true
git commit -m "feat(web): manager active-grants surface with revoke; §10 test 7 through the real routes"
```

---

## Task 12: Admin — collections & postures with apply status

**Files:**
- Create: `mvp/apps/web/app/api/admin/collections/route.ts`, `mvp/apps/web/lib/apply-status.ts`, `mvp/apps/web/app/admin/collections/page.tsx`, `mvp/apps/web/app/admin/collections/CollectionsView.tsx`
- Test: `mvp/apps/web/test/admin-collections.integration.test.ts`

**Interfaces:**
- Produces:
  - `applyStatus(yaml: unknown, applied: unknown | null): "not_applied" | "applied" | "drifted"` from `lib/apply-status.ts`
  - `GET /api/admin/collections` → `{ collections: { name, description, type, taxonomy, status, appliedAt, fields: { name, type, posture, pk, fk, view_join }[] }[] }`
- Consumes: `requireRole`, `loadConfig`, `app.collections`.

**What "apply status" means:** `applyConfig` upserts the collection's current YAML into `app.collections.config` with `updated_at`. So the deployed state is that JSON, and the desired state is `loadConfig(projectDir)`. Comparing them gives exactly three answers: the collection has never been applied, the applied config equals the YAML, or the YAML has moved on and someone needs to run `warehousd apply`. This is a **read-only** view (SPECS §8: *"read-only view of YAML state + apply status"*) — the UI never edits postures.

- [ ] **Step 1: Write the failing test**

Create `mvp/apps/web/test/admin-collections.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";
import { applyStatus } from "../lib/apply-status";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let anaCookie: string, marcusCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("admincolls");
  anaCookie = await signIn(db.auth, "ana@meridian.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

function req(cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  return new Request("http://localhost:8722/api/admin/collections", { headers });
}

describe("applyStatus", () => {
  it("reports not_applied when nothing is recorded", () => {
    expect(applyStatus({ a: 1 }, null)).toBe("not_applied");
  });
  it("reports applied when the two configs match regardless of key order", () => {
    expect(applyStatus({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe("applied");
  });
  it("reports drifted when a posture changed", () => {
    expect(applyStatus(
      { fields: { email: { posture: "deny" } } },
      { fields: { email: { posture: "allow" } } },
    )).toBe("drifted");
  });
});

describe("GET /api/admin/collections", () => {
  it("401s anonymously and 403s for a manager", async () => {
    const { GET } = await import("../app/api/admin/collections/route");
    expect((await GET(req() as any)).status).toBe(401);
    expect((await GET(req(marcusCookie) as any)).status).toBe(403);
  });

  it("returns every collection with its full posture list, including denied fields", async () => {
    const { GET } = await import("../app/api/admin/collections/route");
    const body = await (await GET(req(anaCookie) as any)).json();
    const people = body.collections.find((c: any) => c.name === "people");
    const home = people.fields.find((f: any) => f.name === "home_address");
    // Admins configure postures, so they see the denied fields BY NAME. No values are
    // returned by this route — it reads app.collections, never a data schema.
    expect(home.posture).toBe("deny");
    expect(people.fields.find((f: any) => f.name === "full_name").posture).toBe("allow");
  });

  it("marks a collection applied after applyConfig ran in the fixture", async () => {
    const { GET } = await import("../app/api/admin/collections/route");
    const body = await (await GET(req(anaCookie) as any)).json();
    for (const c of body.collections) expect(c.status).toBe("applied");
  });

  it("marks a collection drifted once the stored config diverges", async () => {
    await getAppPool().query(
      `update app.collections set config = jsonb_set(config, '{description}', '"stale"') where name='metrics'`);
    const { GET } = await import("../app/api/admin/collections/route");
    const body = await (await GET(req(anaCookie) as any)).json();
    expect(body.collections.find((c: any) => c.name === "metrics").status).toBe("drifted");
  });

  it("marks a collection not_applied when there is no row", async () => {
    await getAppPool().query(`delete from app.collections where name='announcements'`);
    const { GET } = await import("../app/api/admin/collections/route");
    const body = await (await GET(req(anaCookie) as any)).json();
    expect(body.collections.find((c: any) => c.name === "announcements").status).toBe("not_applied");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/admin-collections.integration.test.ts
```

Expected: FAIL — modules missing.

- [ ] **Step 3: Implement the comparison**

Create `mvp/apps/web/lib/apply-status.ts`:

```ts
export type ApplyStatus = "not_applied" | "applied" | "drifted";

// Order-insensitive structural comparison. `applyConfig` stores the parsed collection config
// as JSONB, and Postgres does not preserve object key order, so a naive JSON.stringify
// comparison would report drift on every read.
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonical(x)]));
  }
  return v;
}

// Desired state is the YAML on disk; deployed state is what `warehousd apply` last wrote
// into app.collections.config. Three outcomes, no fourth.
export function applyStatus(yaml: unknown, applied: unknown | null): ApplyStatus {
  if (applied === null || applied === undefined) return "not_applied";
  return JSON.stringify(canonical(yaml)) === JSON.stringify(canonical(applied))
    ? "applied" : "drifted";
}
```

Create `mvp/apps/web/app/api/admin/collections/route.ts`:

```ts
import { NextRequest } from "next/server";
import { loadConfig } from "@warehousd/broker";
import { getAppPool } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";
import { applyStatus } from "../../../../lib/apply-status";

const projectDir = process.env.WAREHOUSD_PROJECT_DIR!;

export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const cfg = loadConfig(projectDir);
  const r = await getAppPool().query(`select name, config, updated_at from app.collections`);
  const applied = new Map(r.rows.map((x) => [x.name as string, x]));

  return Response.json({
    collections: Object.entries(cfg.collections).map(([name, c]) => {
      const row = applied.get(name);
      return {
        name,
        description: c.description,
        type: c.type ?? "dataset",
        taxonomy: c.taxonomy ?? null,
        status: applyStatus(c, row?.config ?? null),
        appliedAt: row?.updated_at ?? null,
        fields: Object.entries(c.fields).map(([fname, f]) => ({
          name: fname, type: f.type ?? null, posture: f.posture,
          pk: f.pk ?? false, fk: f.fk ?? null, view_join: f.view_join ?? null,
        })),
      };
    }),
  });
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/admin-collections.integration.test.ts
```

Expected: PASS, 8/8. Note the last two tests mutate `app.collections` — they run last in file order and the DB is disposable, so this is fine.

- [ ] **Step 5: Build the view**

Create `mvp/apps/web/app/admin/collections/CollectionsView.tsx`. One `Card` per collection, each with a header (name, `Badge` for `dataset`/`file`, apply-status badge) and a compact posture table (field, type, posture, key). Postures are the point of the screen, so make them unmissable:

```tsx
function PostureBadge({ posture }: { posture: "allow" | "deny" }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-mono text-xs",
      posture === "allow" ? "text-allow" : "text-deny")}>
      <span aria-hidden>{posture === "allow" ? "✓" : "✗"}</span>
      {posture}
    </Badge>
  );
}

function ApplyBadge({ status }: { status: "applied" | "drifted" | "not_applied" }) {
  const map = {
    applied:     { label: "Applied",     dot: "bg-allow" },
    drifted:     { label: "Drifted",     dot: "bg-pending" },
    not_applied: { label: "Not applied", dot: "bg-muted-foreground" },
  } as const;
  return (
    <Badge variant="outline" className="gap-1.5" role="status">
      <span className={cn("size-1.5 rounded-full", map[status].dot)} />
      {map[status].label}
    </Badge>
  );
}
```

Above the cards, when any collection is `drifted` or `not_applied`, render a bordered notice: *"The configuration on disk differs from what is deployed. Run `warehousd apply` to reconcile."* with the command in a `<Mono copyable>`. The UI must not offer an Apply button — apply is a CLI/deploy operation and governance lives in git (§5.3).

Add a `deny` legend line under the header: *"A field with posture `deny` can never be granted to anyone. Change it in `warehousd.yml` and re-apply."*

Create `mvp/apps/web/app/admin/collections/page.tsx` with `<PageHeader title="Collections" description="The governed surface, as defined in warehousd.yml. Read-only — postures live in git." />` and `<CollectionsView />`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/apply-status.ts apps/web/app/api/admin/collections \
  apps/web/app/admin/collections apps/web/test/admin-collections.integration.test.ts
git commit -m "feat(web): admin collections and postures view with apply status"
```

---

## Task 13: Admin — users and roles

**Files:**
- Create: `mvp/apps/web/app/api/admin/users/route.ts`, `mvp/apps/web/app/api/admin/users/[userId]/route.ts`, `mvp/apps/web/app/admin/users/page.tsx`, `mvp/apps/web/app/admin/users/UsersTable.tsx`
- Test: `mvp/apps/web/test/admin-users.integration.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/admin/users` → `{ users: { id, email, name, role, createdAt, grantCount }[] }`
  - `PATCH /api/admin/users/[userId]` with `{ role }` → `{ ok: true }` | `{ error }`
- Consumes: `requireRole("admin")`.

Two invariants worth enforcing rather than trusting: an admin cannot demote themselves (locking yourself out of the only surface that can undo it), and the last remaining admin cannot be demoted by anyone (locking *everyone* out).

- [ ] **Step 1: Write the failing test**

Create `mvp/apps/web/test/admin-users.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let anaCookie: string, marcusCookie: string, miaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("adminusers");
  anaCookie = await signIn(db.auth, "ana@meridian.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@meridian.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
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
const params = (userId: string) => ({ params: Promise.resolve({ userId }) });
const roleOf = async (id: string) =>
  (await getAppPool().query(`select role from app."user" where id=$1`, [id])).rows[0].role;

describe("GET /api/admin/users", () => {
  it("403s for a manager", async () => {
    const { GET } = await import("../app/api/admin/users/route");
    expect((await GET(req("/api/admin/users", { cookie: marcusCookie }) as any)).status).toBe(403);
  });

  it("lists the three personas with their roles, and no password material", async () => {
    const { GET } = await import("../app/api/admin/users/route");
    const res = await GET(req("/api/admin/users", { cookie: anaCookie }) as any);
    const raw = await res.text();
    expect(raw).not.toMatch(/password/i);
    const body = JSON.parse(raw);
    expect(body.users.find((u: any) => u.id === "ana").role).toBe("admin");
    expect(body.users.find((u: any) => u.id === "mia").role).toBe("member");
  });
});

describe("PATCH /api/admin/users/[userId]", () => {
  it("403s for a manager", async () => {
    const { PATCH } = await import("../app/api/admin/users/[userId]/route");
    const res = await PATCH(
      req("/api/admin/users/mia", { method: "PATCH", cookie: marcusCookie, body: { role: "admin" } }) as any,
      params("mia"));
    expect(res.status).toBe(403);
    expect(await roleOf("mia")).toBe("member");
  });

  it("promotes a member to manager", async () => {
    const { PATCH } = await import("../app/api/admin/users/[userId]/route");
    const res = await PATCH(
      req("/api/admin/users/mia", { method: "PATCH", cookie: anaCookie, body: { role: "manager" } }) as any,
      params("mia"));
    expect(res.status).toBe(200);
    expect(await roleOf("mia")).toBe("manager");
  });

  it("rejects a role outside the three", async () => {
    const { PATCH } = await import("../app/api/admin/users/[userId]/route");
    const res = await PATCH(
      req("/api/admin/users/mia", { method: "PATCH", cookie: anaCookie, body: { role: "superuser" } }) as any,
      params("mia"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_role");
  });

  it("refuses to let an admin demote themselves", async () => {
    const { PATCH } = await import("../app/api/admin/users/[userId]/route");
    const res = await PATCH(
      req("/api/admin/users/ana", { method: "PATCH", cookie: anaCookie, body: { role: "member" } }) as any,
      params("ana"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("cannot_demote_self");
    expect(await roleOf("ana")).toBe("admin");
  });

  it("refuses to demote the last admin", async () => {
    // Promote Mia so there are two admins, demote Ana (allowed), then try to demote Mia.
    const { PATCH } = await import("../app/api/admin/users/[userId]/route");
    await PATCH(req("/api/admin/users/mia", { method: "PATCH", cookie: anaCookie, body: { role: "admin" } }) as any, params("mia"));
    const miaAdminCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
    await PATCH(req("/api/admin/users/ana", { method: "PATCH", cookie: miaAdminCookie, body: { role: "member" } }) as any, params("ana"));
    expect(await roleOf("ana")).toBe("member");

    const res = await PATCH(
      req("/api/admin/users/mia", { method: "PATCH", cookie: miaAdminCookie, body: { role: "member" } }) as any,
      params("mia"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("cannot_demote_self");
  });

  it("404s on an unknown user", async () => {
    const { PATCH } = await import("../app/api/admin/users/[userId]/route");
    const miaAdminCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
    const res = await PATCH(
      req("/api/admin/users/nobody", { method: "PATCH", cookie: miaAdminCookie, body: { role: "member" } }) as any,
      params("nobody"));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/admin-users.integration.test.ts
```

Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

Create `mvp/apps/web/app/api/admin/users/route.ts`:

```ts
import { NextRequest } from "next/server";
import { getAppPool } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";

export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;
  // Explicit column list: `select *` on Better Auth's user table would be one schema bump
  // away from returning credential material.
  const r = await getAppPool().query(`
    select u.id, u.email, u.name, u.role, u."createdAt",
           (select count(*) from app.grants g where g.user_id = u.id and g.status='approved')::int as "grantCount"
    from app."user" u order by u.role, u.email`);
  return Response.json({ users: r.rows });
}
```

Create `mvp/apps/web/app/api/admin/users/[userId]/route.ts`:

```ts
import { NextRequest } from "next/server";
import { getAppPool } from "../../../../lib/broker";
import { requireRole } from "../../../../../lib/authz";

const ROLES = new Set(["admin", "manager", "member"]);

export async function PATCH(
  req: NextRequest, { params }: { params: Promise<{ userId: string }> },
) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;
  const { userId } = await params;
  const { role } = await req.json();
  if (typeof role !== "string" || !ROLES.has(role))
    return Response.json({ error: "invalid_role" }, { status: 400 });

  const app = getAppPool();
  const cur = await app.query(`select role from app."user" where id=$1`, [userId]);
  if (cur.rowCount === 0) return Response.json({ error: "unknown_user" }, { status: 404 });

  // Two lock-out guards. Self-demotion strands the actor outside the only surface that can
  // undo it; demoting the last admin strands everyone.
  if (userId === guard.user.id && role !== "admin")
    return Response.json({ error: "cannot_demote_self" }, { status: 400 });
  if (cur.rows[0].role === "admin" && role !== "admin") {
    const admins = await app.query(`select count(*)::int as n from app."user" where role='admin'`);
    if (admins.rows[0].n <= 1)
      return Response.json({ error: "cannot_demote_last_admin" }, { status: 400 });
  }

  await app.query(`update app."user" set role=$2 where id=$1`, [userId, role]);
  return Response.json({ ok: true });
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/admin-users.integration.test.ts
```

Expected: PASS, 8/8.

- [ ] **Step 5: Build the table**

Create `mvp/apps/web/app/admin/users/UsersTable.tsx`: a `DataTable` with columns email, name, role (a shadcn `Select` that PATCHes on change and shows a `toast`), approved-grant count, created-at. Disable the `Select` on the current user's own row and wrap it in a `Tooltip` reading *"You cannot change your own role."* — a disabled control with no explanation is an anti-pattern.

Above the table, a one-line explainer: *"`admin` manages collections, identity and imports · `manager` approves grants · `member` requests and queries. New SSO users are provisioned as `member`."*

Create `mvp/apps/web/app/admin/users/page.tsx` with the header and the table.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/api/admin/users apps/web/app/admin/users \
  apps/web/test/admin-users.integration.test.ts
git commit -m "feat(web): admin user role management with lock-out guards"
```

---

## Task 14: Admin — audit browser (and scoping the audit feed)

**Files:**
- Modify: `mvp/apps/web/app/api/audit/route.ts`
- Create: `mvp/apps/web/app/admin/audit/page.tsx`, `mvp/apps/web/app/admin/audit/AuditBrowser.tsx`
- Delete: `mvp/apps/web/app/components/Evidence.tsx`
- Test: `mvp/apps/web/test/audit-browser.integration.test.ts`

**Interfaces:**
- Produces: `GET /api/audit?user=&collection=&outcome=&env=&limit=&offset=` → `{ events: AuditEvent[], total: number }`.
- Consumes: `requireSession`, `atLeast`.

**Background:** `GET /api/audit` currently returns the last 50 events **for the whole deployment to any authenticated caller**, with no filters and no scoping. A member can read who queried what, in which environment, and with what outcome, across the entire organisation. Admins are the audience for the global feed (§8); everyone else sees their own trail.

- [ ] **Step 1: Write the failing test**

Create `mvp/apps/web/test/audit-browser.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let anaCookie: string, miaCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("auditbrowser");
  anaCookie = await signIn(db.auth, "ana@meridian.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
  const app = getAppPool();
  await app.query(`
    insert into app.audit_events (user_id, env, collection, outcome, reason, fields_returned) values
      ('mia','dev','people','allowed',null,array['id','full_name']),
      ('mia','dev','salaries','refused','no_grant','{}'),
      ('marcus','live','people','allowed',null,array['id']),
      ('marcus','dev','metrics','refused','field_denied','{}')`);
}, 60_000);
afterAll(async () => { await db?.end(); });

function req(qs: string, cookie: string) {
  return new Request(`http://localhost:8722/api/audit${qs}`, { headers: { cookie } });
}

describe("GET /api/audit", () => {
  it("401s without a session", async () => {
    const { GET } = await import("../app/api/audit/route");
    const res = await GET(new Request("http://localhost:8722/api/audit") as any);
    expect(res.status).toBe(401);
  });

  it("scopes a member to their own events only", async () => {
    const { GET } = await import("../app/api/audit/route");
    const body = await (await GET(req("", miaCookie) as any)).json();
    expect(body.events.length).toBeGreaterThan(0);
    for (const e of body.events) expect(e.user_id).toBe("mia");
  });

  it("ignores a member's attempt to filter to someone else", async () => {
    const { GET } = await import("../app/api/audit/route");
    const body = await (await GET(req("?user=marcus", miaCookie) as any)).json();
    for (const e of body.events) expect(e.user_id).toBe("mia");
  });

  it("gives an admin the whole deployment", async () => {
    const { GET } = await import("../app/api/audit/route");
    const body = await (await GET(req("", anaCookie) as any)).json();
    const users = new Set(body.events.map((e: any) => e.user_id));
    expect(users.has("mia")).toBe(true);
    expect(users.has("marcus")).toBe(true);
  });

  it("filters by user, collection, outcome and env for an admin", async () => {
    const { GET } = await import("../app/api/audit/route");
    const byUser = await (await GET(req("?user=marcus", anaCookie) as any)).json();
    for (const e of byUser.events) expect(e.user_id).toBe("marcus");

    const byColl = await (await GET(req("?collection=salaries", anaCookie) as any)).json();
    for (const e of byColl.events) expect(e.collection).toBe("salaries");

    const byOutcome = await (await GET(req("?outcome=refused", anaCookie) as any)).json();
    for (const e of byOutcome.events) expect(e.outcome).toBe("refused");

    const byEnv = await (await GET(req("?env=live", anaCookie) as any)).json();
    for (const e of byEnv.events) expect(e.env).toBe("live");
  });

  it("rejects an unknown outcome value rather than silently ignoring it", async () => {
    const { GET } = await import("../app/api/audit/route");
    const res = await GET(req("?outcome=maybe", anaCookie) as any);
    expect(res.status).toBe(400);
  });

  it("paginates and reports a total", async () => {
    const { GET } = await import("../app/api/audit/route");
    const page = await (await GET(req("?limit=2&offset=0", anaCookie) as any)).json();
    expect(page.events.length).toBe(2);
    expect(page.total).toBeGreaterThanOrEqual(4);
  });

  it("caps an absurd limit", async () => {
    const { GET } = await import("../app/api/audit/route");
    const body = await (await GET(req("?limit=100000", anaCookie) as any)).json();
    expect(body.events.length).toBeLessThanOrEqual(200);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/audit-browser.integration.test.ts
```

Expected: FAIL — the current handler takes no request argument, ignores filters, and returns a bare array.

- [ ] **Step 3: Implement**

Replace `mvp/apps/web/app/api/audit/route.ts`:

```ts
import { NextRequest } from "next/server";
import { getAppPool } from "../../lib/broker";
import { requireSession } from "../../../lib/authz";
import { atLeast } from "../../../lib/authz";

const MAX_LIMIT = 200;

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if (!guard.ok) return guard.response;
  const q = req.nextUrl.searchParams;

  const where: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, v: unknown) => { values.push(v); where.push(sql.replace("$?", `$${values.length}`)); };

  // Non-admins see their own trail and nothing else — a ?user= from them is ignored, not
  // honoured and not rejected, so the filter UI can stay identical across roles.
  if (atLeast(guard.user.role, "admin")) {
    const user = q.get("user");
    if (user) add("user_id = $?", user);
  } else {
    add("user_id = $?", guard.user.id);
  }

  const collection = q.get("collection");
  if (collection) add("collection = $?", collection);

  const outcome = q.get("outcome");
  if (outcome) {
    if (outcome !== "allowed" && outcome !== "refused")
      return Response.json({ error: "invalid_outcome" }, { status: 400 });
    add("outcome = $?", outcome);
  }

  const env = q.get("env");
  if (env) {
    if (env !== "dev" && env !== "live")
      return Response.json({ error: "invalid_env" }, { status: 400 });
    add("env = $?", env);
  }

  const reason = q.get("reason");
  if (reason) add("reason = $?", reason);

  const limit = Math.min(Math.max(Number(q.get("limit") ?? 50) || 50, 1), MAX_LIMIT);
  const offset = Math.max(Number(q.get("offset") ?? 0) || 0, 0);
  const clause = where.length ? `where ${where.join(" and ")}` : "";
  const app = getAppPool();

  const [rows, total] = await Promise.all([
    app.query(
      `select id, at, user_id, env, collection, intent, fields_returned, grant_id, outcome, reason
       from app.audit_events ${clause} order by at desc limit $${values.length + 1} offset $${values.length + 2}`,
      [...values, limit, offset]),
    app.query(`select count(*)::int as n from app.audit_events ${clause}`, values),
  ]);

  return Response.json({ events: rows.rows, total: total.rows[0].n });
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/audit-browser.integration.test.ts
```

Expected: PASS, 8/8.

- [ ] **Step 5: Build the browser**

Create `mvp/apps/web/app/admin/audit/AuditBrowser.tsx`. This is the evidence surface — it carries the most weight of any screen here.

- Filter bar: `Select` for outcome (Any / allow / deny), `Select` for env, `Input` for user, `Select` for collection (populated from `/api/admin/collections`). Filters push into the query string and refetch.
- `DataTable` columns: timestamp (`Mono`), user (`Mono`), env (`Mono`), collection, outcome (`<OutcomeBadge outcome reason />`), fields returned (`Mono`, muted, `—` when empty), and an intent cell.
- Intent cell: a `Popover` trigger reading `view intent` that shows the raw JSONB pretty-printed in `font-mono text-xs` inside a `ScrollArea`. This is the "prove it's secure" detail — an admin must be able to read the exact proposal the broker validated.
- Pagination: Previous / Next buttons over `offset`, with `Showing X–Y of TOTAL`.
- Empty state: `EmptyState` icon `ScrollText`, title "No matching events", description "Every broker decision lands here — allowed or refused. Widen the filters to see more."

Create `mvp/apps/web/app/admin/audit/page.tsx` with `<PageHeader title="Audit" description="Every broker decision in this deployment, allowed or refused. Append-only — nothing here can be edited or removed." />`.

- [ ] **Step 6: Delete the superseded component**

```bash
cd mvp && git rm apps/web/app/components/Evidence.tsx
grep -rn "components/Evidence" apps/web --include="*.tsx" --include="*.ts" | grep -v node_modules
```

Expected: no hits.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/api/audit/route.ts apps/web/app/admin/audit \
  apps/web/test/audit-browser.integration.test.ts
git commit -m "feat(web): admin audit browser with filters; scope the audit feed by role"
```

---

## Task 15: Admin — OAuth clients (§6.1 admin surface)

**Files:**
- Modify: `mvp/apps/web/app/api/oauth-clients/route.ts` (add `GET`, gate `POST`)
- Create: `mvp/apps/web/app/admin/clients/page.tsx`, `mvp/apps/web/app/admin/clients/ClientsTable.tsx`, `mvp/apps/web/app/admin/clients/NewClientDialog.tsx`
- Test: `mvp/apps/web/test/admin-clients.integration.test.ts`

**Interfaces:**
- Produces: `GET /api/oauth-clients` → `{ clients: { clientId, displayName, allowedScopes, promotedAt, promotedBy, createdAt, lastTokenAt }[] }`.
- Consumes: `getClientPolicy` / `setAllowedScopes` (already in the broker), `requireRole`.

§6.1 is explicit about what this screen must show: *"allowed scopes, promotion audit trail, last token issued, and a 'demote to dev' action."* Three of the four already exist in `app.client_policies`; `lastTokenAt` has to come from Better Auth's access-token table, whose exact name and column casing must be **discovered, not assumed** — the same discipline Phase 2 Task 1 used for `oauthApplication`.

- [ ] **Step 1: Discover the access-token table's real shape**

```bash
cd mvp
docker exec -i $(docker compose -f docker-compose.test.yml ps -q db) psql -U postgres -c "drop database if exists wh_probe" >/dev/null
docker exec -i $(docker compose -f docker-compose.test.yml ps -q db) psql -U postgres -c "create database wh_probe" >/dev/null
docker exec -i $(docker compose -f docker-compose.test.yml ps -q db) psql -U postgres -d wh_probe -c "create schema app" >/dev/null
APP_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:54330/wh_probe" \
  npx @better-auth/cli migrate --config apps/web/lib/auth.ts -y
docker exec -i $(docker compose -f docker-compose.test.yml ps -q db) psql -U postgres -d wh_probe -c \
  "select table_name, column_name, data_type from information_schema.columns
   where table_schema='app' and table_name ilike '%token%' order by table_name, ordinal_position"
docker exec -i $(docker compose -f docker-compose.test.yml ps -q db) psql -U postgres -c "drop database wh_probe" >/dev/null
```

Expected: a table named `oauthAccessToken` with quoted camelCase columns including `clientId`, `userId`, `createdAt`, `accessTokenExpiresAt`. **Write down the exact names you see** and use them verbatim in Step 3. If the table is absent or named differently, stop and adjust this task before writing the query — a wrong identifier here fails at runtime, not at typecheck.

- [ ] **Step 2: Write the failing test**

Create `mvp/apps/web/test/admin-clients.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";
import { getClientPolicy } from "@warehousd/broker";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let anaCookie: string, marcusCookie: string, miaCookie: string;

beforeAll(async () => {
  db = await setupWebDb("adminclients");
  anaCookie = await signIn(db.auth, "ana@meridian.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@meridian.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
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

async function createClient(cookie: string, name: string) {
  const { POST } = await import("../app/api/oauth-clients/route");
  const res = await POST(req("/api/oauth-clients", { method: "POST", cookie, body: { name } }) as any);
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

describe("client creation", () => {
  it("is admin-only", async () => {
    expect((await createClient(miaCookie, "nope")).status).toBe(403);
    expect((await createClient(marcusCookie, "nope")).status).toBe(403);
    expect((await createClient(anaCookie, "yes")).status).toBe(200);
  });

  it("always starts at {env:dev} even when the body asks for live", async () => {
    const { POST } = await import("../app/api/oauth-clients/route");
    const res = await POST(req("/api/oauth-clients", {
      method: "POST", cookie: anaCookie,
      body: { name: "Reporting", allowedScopes: ["env:dev", "env:live"] },
    }) as any);
    const { clientId } = await res.json();
    expect((await getClientPolicy(getAppPool(), clientId)).allowedScopes).toEqual(["env:dev"]);
  });

  it("returns the secret exactly once, at creation", async () => {
    const { body } = await createClient(anaCookie, "Once");
    expect(body.clientSecret).toBeTruthy();
    const { GET } = await import("../app/api/oauth-clients/route");
    const raw = await (await GET(req("/api/oauth-clients", { cookie: anaCookie }) as any)).text();
    expect(raw).not.toContain(body.clientSecret);
    expect(raw).not.toMatch(/clientSecret/);
  });
});

describe("GET /api/oauth-clients", () => {
  it("403s for a manager", async () => {
    const { GET } = await import("../app/api/oauth-clients/route");
    expect((await GET(req("/api/oauth-clients", { cookie: marcusCookie }) as any)).status).toBe(403);
  });

  it("lists clients with scopes and a null promotion trail before promotion", async () => {
    const { body } = await createClient(anaCookie, "Trail");
    const { GET } = await import("../app/api/oauth-clients/route");
    const list = await (await GET(req("/api/oauth-clients", { cookie: anaCookie }) as any)).json();
    const c = list.clients.find((x: any) => x.clientId === body.clientId);
    expect(c.allowedScopes).toEqual(["env:dev"]);
    expect(c.promotedAt).toBeNull();
    expect(c.promotedBy).toBeNull();
    expect(c.lastTokenAt).toBeNull();
  });

  it("shows the promotion trail after a manager promotes", async () => {
    const { body } = await createClient(anaCookie, "Promoted");
    const { POST } = await import("../app/api/oauth-clients/[clientId]/promote/route");
    await POST(req(`/api/oauth-clients/${body.clientId}/promote`, {
      method: "POST", cookie: marcusCookie, body: { action: "promote" },
    }) as any, { params: Promise.resolve({ clientId: body.clientId }) });

    const { GET } = await import("../app/api/oauth-clients/route");
    const list = await (await GET(req("/api/oauth-clients", { cookie: anaCookie }) as any)).json();
    const c = list.clients.find((x: any) => x.clientId === body.clientId);
    expect(c.allowedScopes.sort()).toEqual(["env:dev", "env:live"]);
    expect(c.promotedBy).toBe("marcus");
    expect(c.promotedAt).not.toBeNull();
  });

  it("reports lastTokenAt once a token exists for the client", async () => {
    const { body } = await createClient(anaCookie, "Tokened");
    // Insert a token row directly — minting a real one needs the full OAuth dance, which
    // oauth.integration.test.ts already covers. Column names come from Step 1.
    await getAppPool().query(
      `insert into app."oauthAccessToken"
         (id,"accessToken","refreshToken","accessTokenExpiresAt","refreshTokenExpiresAt",
          "clientId","userId",scopes,"createdAt","updatedAt")
       values ('t1','at','rt', now() + interval '15 min', now() + interval '7 day',
               $1,'ana','env:dev', now(), now())`,
      [body.clientId]);

    const { GET } = await import("../app/api/oauth-clients/route");
    const list = await (await GET(req("/api/oauth-clients", { cookie: anaCookie }) as any)).json();
    expect(list.clients.find((x: any) => x.clientId === body.clientId).lastTokenAt).not.toBeNull();
  });
});
```

If Step 1 showed different column names, correct the `insert` above to match before running.

- [ ] **Step 3: Run it and watch it fail**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/admin-clients.integration.test.ts
```

Expected: FAIL — `GET` is not exported, and `POST` currently admits members.

- [ ] **Step 4: Implement**

Replace `mvp/apps/web/app/api/oauth-clients/route.ts`:

```ts
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { upsertClientPolicy } from "@warehousd/broker";
import { getAppPool } from "../../lib/broker";
import { requireRole } from "../../../lib/authz";

// §6.1: clients are an IT concern. Creation is admin-only; promotion stays manager-or-admin
// (a manager signs off on an app reaching live, an admin owns the credential inventory).
export async function GET(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;
  // Left join: a dynamically registered client (RFC 7591) may have no policy row yet, and
  // getClientPolicy treats a missing row as {env:dev} — mirror that here, never allow-all.
  const r = await getAppPool().query(`
    select a."clientId"                      as "clientId",
           coalesce(p.display_name, a.name)  as "displayName",
           coalesce(p.allowed_scopes, '{env:dev}') as "allowedScopes",
           p.promoted_at                     as "promotedAt",
           p.promoted_by                     as "promotedBy",
           a."createdAt"                     as "createdAt",
           (select max(t."createdAt") from app."oauthAccessToken" t
             where t."clientId" = a."clientId") as "lastTokenAt"
    from app."oauthApplication" a
    left join app.client_policies p on p.client_id = a."clientId"
    order by a."createdAt" desc`);
  return Response.json({ clients: r.rows });
}

// Manually created clients (§6.1 "User-built apps") always start at {env:dev} — no
// creation-time override, regardless of what the request body asks for.
export async function POST(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;
  const { name } = await req.json();

  const id = randomBytes(16).toString("hex");
  const clientId = randomBytes(16).toString("hex");
  const clientSecret = randomBytes(32).toString("hex");
  const app = getAppPool();
  await app.query(
    `insert into app."oauthApplication" ("id","clientId","clientSecret",name,type,"redirectUrls","userId","createdAt","updatedAt")
     values ($1,$2,$3,$4,'web','[]',$5,now(),now())`,
    [id, clientId, clientSecret, name ?? "Untitled client", guard.user.id]);
  await upsertClientPolicy(app, clientId, name ?? null, ["env:dev"]);

  // The secret is returned here and never again — GET deliberately omits it.
  return Response.json({ clientId, clientSecret });
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/admin-clients.integration.test.ts \
  apps/web/test/oauth-clients.integration.test.ts
```

Expected: the new suite passes 7/7. **`oauth-clients.integration.test.ts` will now fail** its first test — it asserts a *member* can create a client, which this task deliberately changes. Update that test: rename it to "admin can create a client; it always starts with {env:dev} — no override", sign in as Ana, and add a case asserting a member gets 403. Its promotion tests create clients as Mia — switch those to Ana too. Re-run both files; both must be green.

- [ ] **Step 6: Build the surface**

Create `mvp/apps/web/app/admin/clients/NewClientDialog.tsx`. The secret is shown exactly once, so the dialog has two states — the form, then a "copy this now" panel:

```tsx
"use client";
import { useState } from "react";
import { AlertTriangle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Mono } from "@/components/common/Mono";

export function NewClientDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ clientId: string; clientSecret: string } | null>(null);

  async function submit() {
    const res = await fetch("/api/oauth-clients", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.ok) { setCreated(await res.json()); onCreated(); }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setCreated(null); setName(""); } }}>
      <DialogTrigger asChild>
        <Button><Plus size={16} className="mr-2" />New client</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Client created</DialogTitle>
              <DialogDescription>
                Copy the secret now — it is not stored in a form we can show you again.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label className="text-xs text-muted-foreground">Client ID</Label>
                <Mono copyable className="text-sm">{created.clientId}</Mono>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Client secret</Label>
                <Mono copyable className="text-sm">{created.clientSecret}</Mono>
              </div>
              <p className="flex items-start gap-2 rounded-md border border-pending/40 p-3 text-xs text-muted-foreground">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-pending" />
                This client is scoped to <b className="mx-1 font-mono">env:dev</b> and can only
                ever receive synthetic data. Build against it, then ask a manager to promote it —
                no new credentials are needed.
              </p>
            </div>
            <DialogFooter><Button onClick={() => setOpen(false)}>Done</Button></DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New client</DialogTitle>
              <DialogDescription>
                For an app you are building against warehousd. Claude and other MCP clients
                register themselves and do not need this.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="name">Name <span className="text-destructive">*</span></Label>
              <Input id="name" placeholder="Quarterly reporting app"
                value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button disabled={!name.trim()} onClick={submit}>Create</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

Create `mvp/apps/web/app/admin/clients/ClientsTable.tsx`: a `DataTable` with columns name, client id (`Mono copyable`), scopes (one `Badge` per scope; `env:live` in `text-allow`), promotion trail (`promotedBy` + relative `promotedAt`, or `—`), last token issued (or "Never"), and a promote/demote action. Both directions go through `POST /api/oauth-clients/{id}/promote` with `{action:"promote"|"demote"}`; both are consequential, so both sit behind `AlertDialog` with copy that states the §6.1 rule-4 timing:

- Promote: *"This client will be able to receive `env:live` tokens on its next refresh — within 15 minutes. Live data is still filtered through each calling user's own grants."*
- Demote: *"`env:live` is removed on the next token refresh — within 15 minutes. Existing tokens keep working until they expire."*

Create `mvp/apps/web/app/admin/clients/page.tsx` with the header, `<NewClientDialog>` as the action, and the table.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/api/oauth-clients/route.ts apps/web/app/admin/clients \
  apps/web/test/admin-clients.integration.test.ts apps/web/test/oauth-clients.integration.test.ts
git commit -m "feat(web): admin clients surface with scopes, promotion trail and last token"
```

---

## Task 16: Admin — SSO configuration

**Files:**
- Create: `mvp/apps/web/app/admin/sso/page.tsx`, `mvp/apps/web/app/admin/sso/SsoProviders.tsx`, `mvp/apps/web/app/admin/sso/AddProviderSheet.tsx`
- Test: `mvp/apps/web/test/admin-sso-ui.integration.test.ts`

**Interfaces:**
- Consumes the Phase 4 API **unchanged**: `GET /api/sso/providers`, `POST /api/sso/providers`, `DELETE /api/sso/providers/[providerId]`, `GET /api/sso/status`. No new routes.

Phase 4 already built and tested the API and its admin gate (`sso-admin.integration.test.ts`). This task is the form §8 asks for — *"SSO configuration"* — plus one regression test proving the UI's exact payload shape is accepted.

- [ ] **Step 1: Read the Phase 4 payload contract**

```bash
cd mvp/apps/web
sed -n '1,200p' test/sso-oidc.integration.test.ts | grep -n -A20 "registerSSOProvider\|providerId\|issuer"
```

Record the exact body keys `POST /api/sso/providers` accepts for OIDC (expected: `providerId`, `issuer`, `domain`, `oidcConfig: { clientId, clientSecret, scopes? }`, and optionally `mapping`) and for SAML. **Use what you find, not what this plan guesses.**

- [ ] **Step 2: Write the failing test**

Create `mvp/apps/web/test/admin-sso-ui.integration.test.ts`. It asserts the payload the form will send is accepted, and that a manager is refused — the point is to pin the contract the UI depends on so a Phase 4 refactor cannot break it silently:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { setupWebDb, signIn } from "./helpers/web-db";

let db: Awaited<ReturnType<typeof setupWebDb>>;
let anaCookie: string, marcusCookie: string;
let idp: Server, idpUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    idp = createServer((rq, rs) => {
      if (rq.url === "/.well-known/openid-configuration") {
        rs.writeHead(200, { "content-type": "application/json" });
        rs.end(JSON.stringify({
          issuer: idpUrl,
          authorization_endpoint: `${idpUrl}/authorize`,
          token_endpoint: `${idpUrl}/token`,
          jwks_uri: `${idpUrl}/jwks`,
          userinfo_endpoint: `${idpUrl}/userinfo`,
          scopes_supported: ["openid", "profile", "email"],
        }));
      } else if (rq.url === "/jwks") {
        rs.writeHead(200, { "content-type": "application/json" });
        rs.end(JSON.stringify({ keys: [{ kty: "RSA", use: "sig", kid: "k", n: "t", e: "AQAB" }] }));
      } else { rs.writeHead(404); rs.end(); }
    }).listen(0, "127.0.0.1", () => {
      const a = idp.address();
      if (a && typeof a !== "string") idpUrl = `http://127.0.0.1:${a.port}`;
      resolve();
    });
  });
  process.env.WAREHOUSD_TRUSTED_ORIGINS = idpUrl;
  db = await setupWebDb("ssoui");
  anaCookie = await signIn(db.auth, "ana@meridian.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@meridian.demo", "demo");
}, 60_000);

afterAll(async () => {
  await db?.end();
  await new Promise<void>((r) => idp.close(() => r()));
});

function req(url: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  return new Request(`http://localhost:8722${url}`, {
    method: opts.method ?? "GET", headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

describe("SSO admin contract used by the UI", () => {
  it("accepts the exact OIDC payload the form sends", async () => {
    const { POST } = await import("../app/api/sso/providers/route");
    const res = await POST(req("/api/sso/providers", {
      method: "POST", cookie: anaCookie,
      body: {
        providerId: "acme-oidc",
        issuer: idpUrl,
        domain: "acme.example",
        oidcConfig: { clientId: "warehousd", clientSecret: "s3cret", scopes: ["openid", "profile", "email"] },
      },
    }) as any);
    expect(res.status).toBe(200);
  });

  it("lists the provider back without leaking the client secret", async () => {
    const { GET } = await import("../app/api/sso/providers/route");
    const res = await GET(req("/api/sso/providers", { cookie: anaCookie }) as any);
    const raw = await res.text();
    expect(raw).not.toContain("s3cret");
    const body = JSON.parse(raw);
    expect(body.providers.some((p: any) => p.providerId === "acme-oidc" && p.type === "oidc")).toBe(true);
  });

  it("is invisible to a manager", async () => {
    const { GET } = await import("../app/api/sso/providers/route");
    expect((await GET(req("/api/sso/providers", { cookie: marcusCookie }) as any)).status).toBe(403);
  });

  it("status is readable without a session so the login page can render", async () => {
    const { GET } = await import("../app/api/sso/status/route");
    const body = await (await GET(req("/api/sso/status") as any)).json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(typeof body.localLoginEnabled).toBe("boolean");
  });

  it("deleting a provider removes it and its linked accounts", async () => {
    const { DELETE } = await import("../app/api/sso/providers/[providerId]/route");
    const res = await DELETE(
      req("/api/sso/providers/acme-oidc", { method: "DELETE", cookie: anaCookie }) as any,
      { params: Promise.resolve({ providerId: "acme-oidc" }) });
    expect(res.status).toBe(200);
    const { GET } = await import("../app/api/sso/providers/route");
    const body = await (await GET(req("/api/sso/providers", { cookie: anaCookie }) as any)).json();
    expect(body.providers.some((p: any) => p.providerId === "acme-oidc")).toBe(false);
  });
});
```

- [ ] **Step 3: Run it**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/admin-sso-ui.integration.test.ts
```

Expected: PASS with no new production code — Phase 4 built all of it. If the first test fails on the payload shape, correct the test to match what Step 1 found and adjust the form in Step 4 to send the same thing.

- [ ] **Step 4: Build the form**

Create `mvp/apps/web/app/admin/sso/AddProviderSheet.tsx`: a `Sheet` with a `Tabs` split between **OIDC** and **SAML**.

OIDC fields: `providerId` (slug, helper *"An internal id. Appears in the sign-in button and cannot be changed later."*), `issuer` (helper *"Your IdP's issuer URL. Discovery runs against `{issuer}/.well-known/openid-configuration`."*), `domain` (helper *"Email domain routed to this provider."*), `clientId`, `clientSecret` (`type="password"`). SAML fields: whatever Step 1 found in `sso-keycloak.integration.test.ts` — do not invent them.

Below the form, a persistent note: *"Private and loopback issuers are rejected by discovery unless the host is listed in `WAREHOUSD_TRUSTED_ORIGINS`."* That is a real Phase 4 behaviour (`lib/sso.ts`) and it is the single most likely reason a first configuration attempt fails.

Create `mvp/apps/web/app/admin/sso/SsoProviders.tsx`: a `DataTable` of providers (providerId `Mono`, type `Badge`, issuer `Mono` truncated with a `Tooltip`, domain) plus a `Delete` action behind an `AlertDialog` warning: *"Users who signed in through this provider will lose their linked accounts and must sign in again."*

Above the table, a status card built from `GET /api/sso/status`:
- providers configured + local login enabled → *"Users can sign in with SSO or local credentials."*
- providers configured + local login disabled → *"SSO is the only way in."* (`text-allow`)
- none configured + local login enabled → *"No IdP configured. Everyone signs in with local credentials — configure SSO before deploying."* (`text-pending`)
- none configured + local login disabled → *"No login method is configured. Nobody can sign in."* (`text-deny`)

Create `mvp/apps/web/app/admin/sso/page.tsx` with `<PageHeader title="SSO" description="Connect your identity provider. First sign-in provisions a member; you promote roles here." />`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/admin/sso apps/web/test/admin-sso-ui.integration.test.ts
git commit -m "feat(web): admin SSO configuration surface over the phase-4 API"
```

---

## Task 17: Admin — regenerate dev data

**Files:**
- Create: `mvp/packages/broker/src/synthetic/regenerate.ts`, `mvp/apps/web/app/api/admin/regen-synth/route.ts`, `mvp/apps/web/app/admin/RegenSynthCard.tsx`
- Modify: `mvp/packages/broker/src/index.ts`, `mvp/packages/cli/src/index.ts`, `mvp/apps/web/app/admin/page.tsx`
- Test: `mvp/packages/broker/test/regenerate.test.ts`, `mvp/apps/web/test/admin-regen.integration.test.ts`

**Interfaces:**
- Produces: `regenerateSynthetic(db: Pool, cfg: WarehousdConfig, seed?: number): Promise<{ collections: string[] }>` exported from `@warehousd/broker`; `POST /api/admin/regen-synth` → `{ ok: true, collections: string[] }`.
- Consumes: `generateSynthetic`, `writeAudit`.

**Background:** the truncate-then-generate loop exists twice already — in `packages/cli/src/index.ts:runSeed` and in `scripts/dev-bootstrap.ts` — and this task needs it a third time. Extract it once, in the broker, and have all three call it.

- [ ] **Step 1: Write the failing broker test**

Create `mvp/packages/broker/test/regenerate.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, generateSynthetic } from "../src/index";
import { regenerateSynthetic } from "../src/synthetic/regenerate";
import { loadConfig } from "../src/config/load";

let p: Provisioned, admin: Pool;
const meridian = new URL("../../../examples/meridian", import.meta.url).pathname;
const cfg = loadConfig(meridian);

beforeAll(async () => {
  p = await provision("regen");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  await generateSynthetic(admin, cfg, 42);
}, 60_000);
afterAll(async () => { await admin.end(); await p.end(); });

const count = async (t: string) =>
  Number((await admin.query(`select count(*)::int as n from data_synth.${t}`)).rows[0].n);

describe("regenerateSynthetic", () => {
  it("is reproducible for a fixed seed", async () => {
    await regenerateSynthetic(admin, cfg, 7);
    const first = (await admin.query(`select id, full_name from data_synth.people order by id`)).rows;
    await regenerateSynthetic(admin, cfg, 7);
    const second = (await admin.query(`select id, full_name from data_synth.people order by id`)).rows;
    expect(second).toEqual(first);
  });

  it("produces different data for a different seed", async () => {
    await regenerateSynthetic(admin, cfg, 1);
    const a = (await admin.query(`select full_name from data_synth.people order by id limit 5`)).rows;
    await regenerateSynthetic(admin, cfg, 2);
    const b = (await admin.query(`select full_name from data_synth.people order by id limit 5`)).rows;
    expect(b).not.toEqual(a);
  });

  it("does not duplicate rows when run repeatedly", async () => {
    await regenerateSynthetic(admin, cfg, 42);
    const once = await count("people");
    await regenerateSynthetic(admin, cfg, 42);
    expect(await count("people")).toBe(once);
  });

  it("skips file collections — they are indexed, not generated", async () => {
    const r = await regenerateSynthetic(admin, cfg, 42);
    expect(r.collections).not.toContain("policies");
    expect(r.collections).toContain("people");
  });

  it("never touches data_live", async () => {
    await admin.query(
      `insert into data_live.departments (id, name) values (gen_random_uuid(), 'Live Only Dept')`);
    const before = Number((await admin.query(`select count(*)::int as n from data_live.departments`)).rows[0].n);
    await regenerateSynthetic(admin, cfg, 99);
    const after = Number((await admin.query(`select count(*)::int as n from data_live.departments`)).rows[0].n);
    expect(after).toBe(before);
  });

  it("preserves FK integrity across regenerations", async () => {
    await regenerateSynthetic(admin, cfg, 5);
    const orphans = await admin.query(`
      select count(*)::int as n from data_synth.salaries s
      left join data_synth.people pp on pp.id = s.person_id
      where s.person_id is not null and pp.id is null`);
    expect(orphans.rows[0].n).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd mvp && npx vitest run packages/broker/test/regenerate.test.ts
```

Expected: FAIL — cannot resolve `../src/synthetic/regenerate`.

- [ ] **Step 3: Implement**

Create `mvp/packages/broker/src/synthetic/regenerate.ts`:

```ts
import type { Pool } from "pg";
import type { WarehousdConfig } from "../config/schema";
import { generateSynthetic } from "./generate";

// Truncate-then-generate, extracted so the CLI (`warehousd seed`), the bootstrap script and
// the admin UI share one implementation instead of three copies that can drift.
//
// data_synth only, always. Invariant 5: the generator has no read path into data_live, and
// this function has no write path into it either — the schema name is a literal.
export async function regenerateSynthetic(
  db: Pool, cfg: WarehousdConfig, seed = 42,
): Promise<{ collections: string[] }> {
  const regenerated: string[] = [];
  for (const name of Object.keys(cfg.collections)) {
    const c = cfg.collections[name];
    // File collections are populated by indexCollection, not the generator.
    if (!c || c.type === "file") continue;
    await db.query(`truncate data_synth.${name} cascade`);
    regenerated.push(name);
  }
  await generateSynthetic(db, cfg, seed);
  return { collections: regenerated };
}
```

Add to `mvp/packages/broker/src/index.ts`:

```ts
export { regenerateSynthetic } from "./synthetic/regenerate";
```

Replace the body of `runSeed` in `mvp/packages/cli/src/index.ts`:

```ts
export async function runSeed(projectDir: string, dbUrl: string, seed = 42): Promise<void> {
  const cfg = loadConfig(projectDir);
  const db = new Pool({ connectionString: dbUrl });
  try { await regenerateSynthetic(db, cfg, seed); } finally { await db.end(); }
}
```

Add `regenerateSynthetic` to the CLI's `@warehousd/broker` import and drop the now-unused `generateSynthetic`.

In `mvp/scripts/dev-bootstrap.ts`, replace the truncate loop plus `generateSynthetic(db, cfg, 42)` with `await regenerateSynthetic(db, cfg, 42);` and update its import.

- [ ] **Step 4: Run it and watch it pass**

```bash
cd mvp && npx vitest run packages/broker/test/regenerate.test.ts packages/cli/test
```

Expected: both green — the CLI's `apply-seed.test.ts` is the regression check on the refactor.

- [ ] **Step 5: Write the failing route test**

Create `mvp/apps/web/test/admin-regen.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let anaCookie: string, marcusCookie: string;

beforeAll(async () => {
  db = await setupWebDbWithData("adminregen");
  anaCookie = await signIn(db.auth, "ana@meridian.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

function req(cookie?: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers["cookie"] = cookie;
  return new Request("http://localhost:8722/api/admin/regen-synth", {
    method: "POST", headers, body: JSON.stringify(body ?? {}),
  });
}

describe("POST /api/admin/regen-synth", () => {
  it("403s for a manager", async () => {
    const { POST } = await import("../app/api/admin/regen-synth/route");
    expect((await POST(req(marcusCookie) as any)).status).toBe(403);
  });

  it("regenerates and reports which collections it touched", async () => {
    const { POST } = await import("../app/api/admin/regen-synth/route");
    const res = await POST(req(anaCookie, { seed: 11 }) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.collections).toContain("people");
    expect(body.collections).not.toContain("policies");
  });

  it("writes one audit event per regenerated collection", async () => {
    const before = await getAppPool().query(
      `select count(*)::int as n from app.audit_events where intent->>'op' = 'regen_synth'`);
    const { POST } = await import("../app/api/admin/regen-synth/route");
    await POST(req(anaCookie, { seed: 12 }) as any);
    const after = await getAppPool().query(
      `select count(*)::int as n from app.audit_events where intent->>'op' = 'regen_synth'`);
    expect(after.rows[0].n).toBeGreaterThan(before.rows[0].n);

    const one = await getAppPool().query(
      `select user_id, env, outcome from app.audit_events
       where intent->>'op' = 'regen_synth' order by at desc limit 1`);
    expect(one.rows[0]).toMatchObject({ user_id: "ana", env: "dev", outcome: "allowed" });
  });

  it("leaves data_live untouched even when the caller's env cookie says live", async () => {
    const app = getAppPool();
    const before = await app.query(`select count(*)::int as n from data_live.people`);
    const { POST } = await import("../app/api/admin/regen-synth/route");
    const r = new Request("http://localhost:8722/api/admin/regen-synth", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${anaCookie}; wh_env=live` },
      body: JSON.stringify({}),
    });
    expect((await POST(r as any)).status).toBe(200);
    const after = await app.query(`select count(*)::int as n from data_live.people`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("rejects a non-numeric seed", async () => {
    const { POST } = await import("../app/api/admin/regen-synth/route");
    const res = await POST(req(anaCookie, { seed: "banana" }) as any);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 6: Implement the route**

Create `mvp/apps/web/app/api/admin/regen-synth/route.ts`:

```ts
import { NextRequest } from "next/server";
import { loadConfig, regenerateSynthetic } from "@warehousd/broker";
import { getAppPool } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";

const projectDir = process.env.WAREHOUSD_PROJECT_DIR!;

export async function POST(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const { seed } = await req.json().catch(() => ({}));
  if (seed !== undefined && (typeof seed !== "number" || !Number.isFinite(seed)))
    return Response.json({ error: "invalid_seed" }, { status: 400 });

  const app = getAppPool();
  const cfg = loadConfig(projectDir);
  const { collections } = await regenerateSynthetic(app, cfg, seed ?? 42);

  // Destroying and rebuilding a whole environment is a governance event. Audited per
  // collection so the audit browser's collection filter finds it. env is the literal 'dev':
  // this operation cannot touch live, so the caller's env cookie is irrelevant here.
  for (const collection of collections) {
    await app.query(
      `insert into app.audit_events (user_id, env, collection, intent, fields_returned, outcome, reason)
       values ($1, 'dev', $2, $3, '{}', 'allowed', null)`,
      [guard.user.id, collection, JSON.stringify({ op: "regen_synth", seed: seed ?? 42 })]);
  }

  return Response.json({ ok: true, collections });
}
```

- [ ] **Step 7: Run it and watch it pass**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/admin-regen.integration.test.ts
```

Expected: PASS, 5/5.

- [ ] **Step 8: Build the card and the admin overview**

Create `mvp/apps/web/app/admin/RegenSynthCard.tsx`: a `Card` with the explanation *"Synthetic data is generated from the schema alone — never sampled from real data. Regenerating discards every row in `data_synth` and rebuilds it from the seed."*, a seed `Input` (default 42), and a **Regenerate** button behind an `AlertDialog`: *"Every synthetic row is discarded and rebuilt. Grants, audit history and live data are untouched."* On success, `toast.success` naming the collection count.

Replace `mvp/apps/web/app/admin/page.tsx` with an overview: `PageHeader` plus a responsive grid of `Card`s — collections applied/drifted counts, user counts by role, pending grant count, audit events in the last 24h (each linking to its section) — and `<RegenSynthCard />`. Source the counts from the existing admin routes; no new endpoint.

- [ ] **Step 9: Commit**

```bash
git add packages/broker/src/synthetic/regenerate.ts packages/broker/src/index.ts \
  packages/broker/test/regenerate.test.ts packages/cli/src/index.ts scripts/dev-bootstrap.ts \
  apps/web/app/api/admin/regen-synth apps/web/app/admin \
  apps/web/test/admin-regen.integration.test.ts
git commit -m "feat: shared regenerateSynthetic and an audited admin regenerate-dev-data action"
```

---

## Task 18: The `warehousd_import` role — a fourth wall

**Files:**
- Modify: `mvp/packages/broker/src/db/pools.ts`, `mvp/packages/broker/src/apply/ddl.ts`, `mvp/packages/broker/src/apply/apply.ts`, `mvp/packages/broker/src/db/migrate-app.ts`, `mvp/packages/broker/test/helpers/db.ts`, `mvp/apps/web/test/helpers/web-db.ts`, `mvp/scripts/dev-bootstrap.ts`
- Test: `mvp/packages/broker/test/import-role.test.ts`

**Interfaces:**
- Produces:
  - `Pools` gains `imp: Pool | null`; `createPools({ app, dev, live, imp? })`.
  - `grantImportDDL(collection: string): string` — issues `INSERT` on the live base table only.
- Consumes: nothing new.

**Why a fourth role.** The dev/live wall is structural because the database refuses, not because the code remembers (invariant 5). The import path is the only write into `data_live`, so it gets the same treatment: a role that can `INSERT` into live base tables and **cannot `SELECT` from them**, cannot `UPDATE`, cannot `DELETE`, and has no privileges on `data_synth` at all. A bug in the import route therefore cannot become a read path into real data, and cannot corrupt existing rows.

This mirrors the Phase 0.5 indexer reasoning: the writer gets its own role, and the read roles gain nothing.

- [ ] **Step 1: Write the failing test**

Create `mvp/packages/broker/test/import-role.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig } from "../src/index";
import { loadConfig } from "../src/config/load";

let p: Provisioned, admin: Pool, imp: Pool;
const cfg = loadConfig(new URL("../../../examples/meridian", import.meta.url).pathname);

beforeAll(async () => {
  p = await provision("importrole");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  imp = new Pool({ connectionString: p.urls.imp });
}, 60_000);
afterAll(async () => { await admin.end(); await imp.end(); await p.end(); });

describe("warehousd_import privileges", () => {
  it("can INSERT into a data_live base table", async () => {
    await expect(imp.query(
      `insert into data_live.departments (id, name) values (gen_random_uuid(), 'Imported')`,
    )).resolves.toBeDefined();
  });

  it("cannot SELECT from data_live — write-only means write-only", async () => {
    await expect(imp.query(`select * from data_live.departments`)).rejects.toThrow(/permission denied/i);
  });

  it("cannot SELECT the live view either", async () => {
    await expect(imp.query(`select * from data_live.v_people`)).rejects.toThrow(/permission denied/i);
  });

  it("cannot UPDATE or DELETE — an import appends, it never rewrites history", async () => {
    await expect(imp.query(`update data_live.departments set name='x'`)).rejects.toThrow(/permission denied/i);
    await expect(imp.query(`delete from data_live.departments`)).rejects.toThrow(/permission denied/i);
  });

  it("has no privileges at all on data_synth", async () => {
    await expect(imp.query(`select * from data_synth.people`)).rejects.toThrow(/permission denied/i);
    await expect(imp.query(
      `insert into data_synth.departments (id, name) values (gen_random_uuid(), 'x')`,
    )).rejects.toThrow(/permission denied/i);
  });

  it("cannot read app.grants — it is not a decision-making role", async () => {
    await expect(imp.query(`select * from app.grants`)).rejects.toThrow(/permission denied/i);
  });

  it("satisfies a foreign key without needing privileges on the referenced table", async () => {
    // RI triggers run with the referenced table owner's privileges, so an INSERT-only role
    // can insert a child row it cannot read the parent of. Asserted because the whole
    // import path depends on it.
    const person = (await admin.query(
      `insert into data_live.people (id, full_name) values (gen_random_uuid(), 'Parent') returning id`,
    )).rows[0].id;
    await expect(imp.query(
      `insert into data_live.salaries (id, person_id, job_title, currency)
       values (gen_random_uuid(), $1, 'Engineer', 'USD')`, [person],
    )).resolves.toBeDefined();
  });

  it("is rejected by the FK when the parent does not exist", async () => {
    await expect(imp.query(
      `insert into data_live.salaries (id, person_id, job_title, currency)
       values (gen_random_uuid(), gen_random_uuid(), 'Ghost', 'USD')`,
    )).rejects.toThrow(/foreign key/i);
  });
});

describe("the read roles gain nothing", () => {
  it("warehousd_live still cannot write", async () => {
    const live = new Pool({ connectionString: p.urls.live });
    await expect(live.query(
      `insert into data_live.departments (id, name) values (gen_random_uuid(), 'x')`,
    )).rejects.toThrow(/permission denied/i);
    await live.end();
  });

  it("warehousd_dev still cannot see data_live", async () => {
    const dev = new Pool({ connectionString: p.urls.dev });
    await expect(dev.query(`select * from data_live.v_people`)).rejects.toThrow(/permission denied/i);
    await dev.end();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd mvp && npx vitest run packages/broker/test/import-role.test.ts
```

Expected: FAIL — `p.urls.imp` is `undefined`.

- [ ] **Step 3: Create the role in the test provisioner**

Read `mvp/packages/broker/test/helpers/db.ts` first. It creates `warehousd_dev` and `warehousd_live` and returns `urls: { admin, dev, live }`. Add the third role alongside them, matching the existing style exactly:

```sql
do $$ begin
  if not exists (select from pg_roles where rolname='warehousd_import')
    then create role warehousd_import login password 'pw'; end if;
end $$;
grant usage on schema data_live to warehousd_import;
```

and extend the returned `urls` with:

```ts
imp: `postgres://warehousd_import:pw@127.0.0.1:54330/${dbName}`,
```

Note what is deliberately **absent**: no `grant usage on schema data_synth`, no `grant usage on schema app`. Add a comment saying so — the omissions are the security property.

- [ ] **Step 4: Issue the table grants during apply**

In `mvp/packages/broker/src/apply/ddl.ts`, add below `grantViewDDL`:

```ts
// The import role writes live BASE tables (not views — a view insert would need rules) and
// gets nothing else: no SELECT, no UPDATE, no DELETE, and nothing at all in data_synth.
// Synthetic data is generated, never imported, so there is no dev counterpart by design.
export function grantImportDDL(collection: string, cfg: WarehousdConfig): string {
  const c = cfg.collections[collection];
  if (!c) throw new Error(`Unknown collection: ${collection}`);
  // File collections are populated by the indexer under the owner role, not by import.
  if (c.type === "file") return "";
  return `grant insert on data_live.${collection} to warehousd_import;`;
}
```

In `mvp/packages/broker/src/apply/apply.ts`, inside the second loop (the one that already calls `viewDDL` and `grantViewDDL`), after `grantViewDDL`:

```ts
    const importGrant = grantImportDDL(name, cfg);
    if (importGrant) await db.query(importGrant);
```

Add `grantImportDDL` to the `./ddl` import. Guard it so a deployment without the role does not break `apply`:

```ts
  // A stack provisioned before the import role existed still applies cleanly.
  const hasImportRole = (await db.query(
    `select 1 from pg_roles where rolname='warehousd_import'`)).rowCount === 1;
```

and wrap the grant in `if (hasImportRole && importGrant)`.

- [ ] **Step 5: Add the pool**

In `mvp/packages/broker/src/db/pools.ts`, extend the type and constructor. `dataPool` is untouched — the import pool is never selected by env:

```ts
export type Pools = {
  app: Pool;   // owner — app schema, no data privileges
  dev: Pool;   // warehousd_dev  — data_synth only
  live: Pool;  // warehousd_live — data_live only
  imp: Pool | null;  // warehousd_import — INSERT-only on data_live base tables
  end: () => Promise<void>;
};

export function createPools(urls: {
  app: string; dev: string; live: string; imp?: string;
}): Pools {
  const app = new Pool({ connectionString: urls.app });
  const dev = new Pool({ connectionString: urls.dev });
  const live = new Pool({ connectionString: urls.live });
  // Optional: a deployment with no import path configured simply has no write path into
  // data_live, which is the safer default. The import route reports it as unconfigured.
  const imp = urls.imp ? new Pool({ connectionString: urls.imp }) : null;
  return {
    app, dev, live, imp,
    end: async () => {
      await Promise.all([app.end(), dev.end(), live.end(), imp?.end()].filter(Boolean));
    },
  };
}
```

- [ ] **Step 6: Run it and watch it pass**

```bash
cd mvp && npx vitest run packages/broker/test/import-role.test.ts
```

Expected: PASS, 10/10. If the FK test fails with `permission denied for table people`, this Postgres version does require SELECT on the referenced table — in that case add `grant select (id) on data_live.<parent> to warehousd_import` for FK parents only, note it in the comment, and update the "cannot SELECT" test to be column-specific. Do not blanket-grant SELECT.

- [ ] **Step 7: Wire the role into the other provisioning paths**

`mvp/scripts/dev-bootstrap.ts` — add to the existing `do $$ ... end $$` role block and the grants below it:

```sql
      if not exists (select from pg_roles where rolname='warehousd_import') then create role warehousd_import login password 'pw'; end if;
```
```sql
    grant usage on schema data_live to warehousd_import;
```

`mvp/apps/web/test/helpers/web-db.ts` — the same two lines in `setupWebDb`'s DDL block, and in `setupWebDbWithData` add:

```ts
  process.env.IMPORT_DATABASE_URL = `postgres://warehousd_import:pw@127.0.0.1:54330/${base.dbName}`;
```

next to the existing `DEV_DATABASE_URL` / `LIVE_DATABASE_URL` assignments.

`mvp/apps/web/app/lib/broker.ts` — pass it through:

```ts
  const pools = createPools({
    app:  process.env.APP_DATABASE_URL!,
    dev:  process.env.DEV_DATABASE_URL!,
    live: process.env.LIVE_DATABASE_URL!,
    imp:  process.env.IMPORT_DATABASE_URL,
  });
```

- [ ] **Step 8: Full broker suite**

```bash
cd mvp && npx vitest run packages/broker
```

Expected: green, including `db-roles.test.ts` — which must still pass unchanged, proving the new role widened nothing for the existing two.

- [ ] **Step 9: Commit**

```bash
git add packages/broker/src/db/pools.ts packages/broker/src/apply \
  packages/broker/test/helpers/db.ts packages/broker/test/import-role.test.ts \
  apps/web/test/helpers/web-db.ts apps/web/app/lib/broker.ts scripts/dev-bootstrap.ts
git commit -m "feat(broker): warehousd_import role with INSERT-only access to data_live"
```

---

## Task 19: CSV/JSON parsing and schema validation

**Files:**
- Create: `mvp/packages/broker/src/import/csv.ts`, `mvp/packages/broker/src/import/validate.ts`
- Test: `mvp/packages/broker/test/import-validate.test.ts`

**Interfaces:**
- Produces:
  - `parseCsv(text: string): Record<string, string>[]`
  - `parseImportPayload(text: string, format: "csv" | "json"): Record<string, unknown>[]`
  - `validateImportRows(cfg, collection, rows, opts?): { ok: true; columns: string[]; values: unknown[][] } | { ok: false; errors: ImportError[] }`
  - `type ImportError = { row: number; column: string | null; reason: string }`
- Consumes: `WarehousdConfig`, `FieldConfig`.

**Error discipline:** an `ImportError` carries a row index, a column name and a reason **code** — never the offending value. Import errors are shown to an admin, but the same discipline as invariant 4 applies: values from a file that may contain real personal data do not get echoed back into a response body or a log line.

- [ ] **Step 1: Write the failing test**

Create `mvp/packages/broker/test/import-validate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseCsv, parseImportPayload } from "../src/import/csv";
import { validateImportRows } from "../src/import/validate";
import { loadConfig } from "../src/config/load";

const cfg = loadConfig(new URL("../../../examples/meridian", import.meta.url).pathname);
const UUID = "3f8b0e4a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const UUID2 = "4a9c1f5b-2d3e-4f60-9b0c-1d2e3f4a5b6c";

describe("parseCsv", () => {
  it("parses a simple sheet with a header row", () => {
    expect(parseCsv("a,b\n1,2\n3,4")).toEqual([{ a: "1", b: "2" }, { a: "3", b: "4" }]);
  });
  it("honours quoted fields containing commas", () => {
    expect(parseCsv(`a,b\n"x,y",z`)).toEqual([{ a: "x,y", b: "z" }]);
  });
  it("honours escaped quotes", () => {
    expect(parseCsv(`a\n"he said ""hi"""`)).toEqual([{ a: 'he said "hi"' }]);
  });
  it("honours newlines inside quoted fields", () => {
    expect(parseCsv(`a,b\n"line1\nline2",z`)).toEqual([{ a: "line1\nline2", b: "z" }]);
  });
  it("tolerates CRLF", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([{ a: "1", b: "2" }]);
  });
  it("skips a trailing blank line", () => {
    expect(parseCsv("a\n1\n\n")).toEqual([{ a: "1" }]);
  });
  it("throws when a row has more cells than the header", () => {
    expect(() => parseCsv("a,b\n1,2,3")).toThrow(/column count/i);
  });
  it("throws on an empty document", () => {
    expect(() => parseCsv("")).toThrow(/empty/i);
  });
});

describe("parseImportPayload", () => {
  it("accepts a bare JSON array", () => {
    expect(parseImportPayload(`[{"a":1}]`, "json")).toEqual([{ a: 1 }]);
  });
  it("accepts a {rows:[...]} envelope", () => {
    expect(parseImportPayload(`{"rows":[{"a":1}]}`, "json")).toEqual([{ a: 1 }]);
  });
  it("rejects a JSON object that is neither", () => {
    expect(() => parseImportPayload(`{"a":1}`, "json")).toThrow(/array/i);
  });
  it("rejects malformed JSON with a clean message", () => {
    expect(() => parseImportPayload("{oops", "json")).toThrow(/parse/i);
  });
});

describe("validateImportRows", () => {
  it("accepts a well-formed dataset row and returns positional values", () => {
    const r = validateImportRows(cfg, "departments", [{ id: UUID, name: "Robotics" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.columns).toEqual(["id", "name"]);
    expect(r.values).toEqual([[UUID, "Robotics"]]);
  });

  it("accepts posture:deny columns — postures govern reading, not writing", () => {
    const r = validateImportRows(cfg, "people", [
      { id: UUID, full_name: "A B", email: "a@b.c", home_address: "1 Main St", phone: "555" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.columns).toContain("home_address");
  });

  it("rejects a column that is not in the collection at all", () => {
    const r = validateImportRows(cfg, "departments", [{ id: UUID, name: "X", nickname: "Y" }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toMatchObject({ row: 0, column: "nickname", reason: "unknown_column" });
  });

  it("rejects a view_join column — it lives on the joined table, not here", () => {
    const r = validateImportRows(cfg, "people", [
      { id: UUID, full_name: "A", department_name: "Robotics" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0].reason).toBe("derived_column");
  });

  it("rejects a file collection outright", () => {
    const r = validateImportRows(cfg, "policies", [{ title: "x" }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0].reason).toBe("file_collection");
  });

  it("rejects an unknown collection", () => {
    const r = validateImportRows(cfg, "nope", [{ a: 1 }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0].reason).toBe("unknown_collection");
  });

  it("rejects a malformed uuid", () => {
    const r = validateImportRows(cfg, "departments", [{ id: "not-a-uuid", name: "X" }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toMatchObject({ row: 0, column: "id", reason: "invalid_uuid" });
  });

  it("rejects a non-numeric value in a numeric column", () => {
    const r = validateImportRows(cfg, "metrics", [
      { id: UUID, date: "2026-01-01", revenue: "lots", active_customers: 10, region: "emea" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toMatchObject({ column: "revenue", reason: "invalid_numeric" });
  });

  it("coerces numeric strings from CSV into numbers", () => {
    const r = validateImportRows(cfg, "metrics", [
      { id: UUID, date: "2026-01-01", revenue: "1234.5", active_customers: "10", region: "emea" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const i = r.columns.indexOf("revenue");
    expect(r.values[0]![i]).toBe(1234.5);
  });

  it("rejects an unparseable date", () => {
    const r = validateImportRows(cfg, "metrics", [
      { id: UUID, date: "the fifth of never", revenue: 1, active_customers: 1, region: "emea" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0].reason).toBe("invalid_date");
  });

  it("rejects a missing primary key", () => {
    const r = validateImportRows(cfg, "departments", [{ name: "X" }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toMatchObject({ column: "id", reason: "missing_required" });
  });

  it("rejects a duplicate primary key inside one payload", () => {
    const r = validateImportRows(cfg, "departments", [
      { id: UUID, name: "A" }, { id: UUID, name: "B" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toMatchObject({ row: 1, column: "id", reason: "duplicate_pk" });
  });

  it("treats an empty string as null on a nullable column and as an error otherwise", () => {
    const ok = validateImportRows(cfg, "people", [
      { id: UUID, full_name: "A", email: "" },
    ]);
    // `email` has no `nullable: true` in the Meridian YAML, so an empty value is an error.
    expect(ok.ok).toBe(false);
    if (ok.ok) throw new Error("unreachable");
    expect(ok.errors[0].reason).toBe("missing_required");
  });

  it("validates a taxonomy value against the bound vocabulary", () => {
    const bad = validateImportRows(cfg, "announcements", [
      { id: UUID, title: "T", category: "not-a-term", summary: "s", owner: "o",
        updated_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("unreachable");
    expect(bad.errors[0]).toMatchObject({ column: "category", reason: "unknown_term" });

    const good = validateImportRows(cfg, "announcements", [
      { id: UUID, title: "T", category: "hr", summary: "s", owner: "o",
        updated_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(good.ok).toBe(true);
  });

  it("collects every error, not just the first", () => {
    const r = validateImportRows(cfg, "departments", [
      { id: "bad", name: "A" }, { id: "worse", name: "B" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors.length).toBe(2);
  });

  it("caps the error list so a wholly malformed file cannot flood the response", () => {
    const rows = Array.from({ length: 500 }, () => ({ id: "bad", name: "A" }));
    const r = validateImportRows(cfg, "departments", rows);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors.length).toBeLessThanOrEqual(50);
  });

  it("rejects a payload above the row cap", () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ id: UUID, name: `d${i}` }));
    const r = validateImportRows(cfg, "departments", rows, { maxRows: 10 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0].reason).toBe("too_many_rows");
  });

  it("never echoes an offending value back in an error", () => {
    const r = validateImportRows(cfg, "people", [
      { id: UUID, full_name: "A", email: "a@b.c", home_address: 12345 },
    ]);
    expect(JSON.stringify(r)).not.toContain("12345");
  });

  it("requires a consistent column set across rows", () => {
    const r = validateImportRows(cfg, "departments", [
      { id: UUID, name: "A" }, { id: UUID2 },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors[0]).toMatchObject({ row: 1, reason: "ragged_rows" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd mvp && npx vitest run packages/broker/test/import-validate.test.ts
```

Expected: FAIL — modules missing.

- [ ] **Step 3: Implement the CSV parser**

Create `mvp/packages/broker/src/import/csv.ts`. Hand-rolled on purpose: the broker carries four runtime dependencies (`pg`, `yaml`, `zod`, `drizzle-orm`) and adding a CSV library to parse an admin upload is not worth the supply-chain surface.

```ts
// RFC 4180 subset: comma-delimited, double-quote escaping, quoted fields may contain
// commas and newlines, CRLF tolerated. No custom delimiters, no comment lines — an import
// file is a spreadsheet export, not a config format.
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ",") { endField(); i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { endRow(); i++; continue; }
    field += ch; i++;
  }
  if (field.length > 0 || row.length > 0) endRow();

  // Drop trailing blank lines (a single empty cell from a final newline).
  while (rows.length && rows[rows.length - 1]!.every((c) => c === "")) rows.pop();
  if (rows.length === 0) throw new Error("CSV document is empty");

  const header = rows[0]!.map((h) => h.trim());
  return rows.slice(1).map((r, n) => {
    if (r.length !== header.length)
      throw new Error(`CSV row ${n + 1} has a column count of ${r.length}, header has ${header.length}`);
    return Object.fromEntries(header.map((h, k) => [h, r[k]!]));
  });
}

export function parseImportPayload(
  text: string, format: "csv" | "json",
): Record<string, unknown>[] {
  if (format === "csv") return parseCsv(text);
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("Could not parse JSON payload"); }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { rows?: unknown }).rows)
      ? (parsed as { rows: unknown[] }).rows
      : null;
  if (!rows) throw new Error("JSON payload must be an array of rows or {\"rows\": [...]}");
  return rows as Record<string, unknown>[];
}
```

- [ ] **Step 4: Implement the validator**

Create `mvp/packages/broker/src/import/validate.ts`:

```ts
import type { WarehousdConfig, FieldConfig } from "../config/schema";

export type ImportError = { row: number; column: string | null; reason: string };

export type ImportPlan = { columns: string[]; values: unknown[][] };
export type ImportValidation =
  | { ok: true; columns: string[]; values: unknown[][] }
  | { ok: false; errors: ImportError[] };

const MAX_ERRORS = 50;
const DEFAULT_MAX_ROWS = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Coerce one cell to its declared type, or return a reason code. CSV delivers everything as
// a string, so the numeric/boolean/date branches must accept string input.
//
// Errors carry a reason code and never the value: an import file may hold real personal
// data, and an error body is still a response body (invariant 4's discipline).
function coerce(v: unknown, f: FieldConfig): { ok: true; value: unknown } | { ok: false; reason: string } {
  switch (f.type) {
    case "uuid":
      return typeof v === "string" && UUID_RE.test(v)
        ? { ok: true, value: v } : { ok: false, reason: "invalid_uuid" };
    case "int": {
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (!Number.isInteger(n)) return { ok: false, reason: "invalid_int" };
      return { ok: true, value: n };
    }
    case "numeric": {
      const n = typeof v === "number" ? v : Number(String(v).trim());
      if (!Number.isFinite(n)) return { ok: false, reason: "invalid_numeric" };
      return { ok: true, value: n };
    }
    case "boolean": {
      if (typeof v === "boolean") return { ok: true, value: v };
      const s = String(v).trim().toLowerCase();
      if (["true", "t", "1", "yes"].includes(s)) return { ok: true, value: true };
      if (["false", "f", "0", "no"].includes(s)) return { ok: true, value: false };
      return { ok: false, reason: "invalid_boolean" };
    }
    case "date":
    case "timestamptz": {
      const t = Date.parse(String(v));
      if (Number.isNaN(t)) return { ok: false, reason: "invalid_date" };
      return { ok: true, value: new Date(t).toISOString() };
    }
    case "json":
      if (typeof v === "object") return { ok: true, value: JSON.stringify(v) };
      try { JSON.parse(String(v)); return { ok: true, value: String(v) }; }
      catch { return { ok: false, reason: "invalid_json" }; }
    case "text":
    default:
      return typeof v === "string" || typeof v === "number"
        ? { ok: true, value: String(v) } : { ok: false, reason: "invalid_text" };
  }
}

export function validateImportRows(
  cfg: WarehousdConfig,
  collection: string,
  rows: Record<string, unknown>[],
  opts: { maxRows?: number } = {},
): ImportValidation {
  const c = cfg.collections[collection];
  if (!c) return { ok: false, errors: [{ row: -1, column: null, reason: "unknown_collection" }] };
  // Files are ingested by the indexer, which owns chunking, checksums and deletion sync.
  if (c.type === "file")
    return { ok: false, errors: [{ row: -1, column: null, reason: "file_collection" }] };

  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  if (rows.length > maxRows)
    return { ok: false, errors: [{ row: -1, column: null, reason: "too_many_rows" }] };
  if (rows.length === 0)
    return { ok: false, errors: [{ row: -1, column: null, reason: "no_rows" }] };

  const errors: ImportError[] = [];
  const push = (e: ImportError) => { if (errors.length < MAX_ERRORS) errors.push(e); };

  // Storable columns: everything on the collection EXCEPT view_join fields, which are
  // resolved from a sibling table at view time and have no column on the base table.
  //
  // posture:deny columns ARE storable. Postures govern who may read a field, not whether it
  // exists — `people.home_address` is real data that must be importable and permanently
  // unreadable through the broker.
  const storable = new Map<string, FieldConfig>(
    Object.entries(c.fields).filter(([, f]) => !f.view_join));
  const pk = Object.entries(c.fields).find(([, f]) => f.pk)?.[0] ?? null;
  const termSlugs = c.taxonomy
    ? new Set(Object.keys(cfg.taxonomies[c.taxonomy]?.terms ?? {})) : null;

  const first = rows[0]!;
  const columns = Object.keys(first);
  for (const col of columns) {
    const f = c.fields[col];
    if (!f) { push({ row: 0, column: col, reason: "unknown_column" }); continue; }
    if (f.view_join) push({ row: 0, column: col, reason: "derived_column" });
  }
  if (errors.length) return { ok: false, errors };

  // Every non-nullable storable column must be present in the payload's column set.
  for (const [name, f] of storable) {
    if (columns.includes(name)) continue;
    if (f.nullable) continue;
    push({ row: 0, column: name, reason: "missing_required" });
  }
  if (errors.length) return { ok: false, errors };

  const seenPk = new Set<string>();
  const values: unknown[][] = [];

  rows.forEach((r, idx) => {
    const keys = Object.keys(r);
    if (keys.length !== columns.length || !columns.every((k) => k in r)) {
      push({ row: idx, column: null, reason: "ragged_rows" });
      return;
    }
    const out: unknown[] = [];
    for (const col of columns) {
      const f = storable.get(col)!;
      const raw = r[col];
      const empty = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
      if (empty) {
        if (!f.nullable) { push({ row: idx, column: col, reason: "missing_required" }); out.push(null); continue; }
        out.push(null);
        continue;
      }
      if (termSlugs && col === c.taxonomy) {
        if (!termSlugs.has(String(raw))) { push({ row: idx, column: col, reason: "unknown_term" }); out.push(null); continue; }
        out.push(String(raw));
        continue;
      }
      const co = coerce(raw, f);
      if (!co.ok) { push({ row: idx, column: col, reason: co.reason }); out.push(null); continue; }
      out.push(co.value);
    }
    if (pk && columns.includes(pk)) {
      const key = String(out[columns.indexOf(pk)]);
      if (seenPk.has(key)) push({ row: idx, column: pk, reason: "duplicate_pk" });
      seenPk.add(key);
    }
    values.push(out);
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, columns, values };
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd mvp && npx vitest run packages/broker/test/import-validate.test.ts
```

Expected: PASS. Where a test fails because the Meridian YAML differs from an assumption above (for example `email` turning out to be `nullable`), **read `examples/meridian/warehousd.yml` and fix the test's expectation to match reality** — do not loosen the validator.

- [ ] **Step 6: Commit**

```bash
git add packages/broker/src/import packages/broker/test/import-validate.test.ts
git commit -m "feat(broker): CSV/JSON import parsing and schema validation"
```

---

## Task 20: `importCollection` — the only write path into `data_live`

**Files:**
- Create: `mvp/packages/broker/src/import/run.ts`
- Modify: `mvp/packages/broker/src/index.ts`
- Test: `mvp/packages/broker/test/import-run.test.ts`

**Interfaces:**
- Produces:
  ```ts
  importCollection(pools: Pools, cfg: WarehousdConfig, actor: string, collection: string,
    payload: { text: string; format: "csv" | "json" }): Promise<ImportResult>

  type ImportResult =
    | { ok: true; imported: number; columns: string[]; auditId: string }
    | { ok: false; reason: string; errors?: ImportError[]; auditId: string | null };
  ```
- Consumes: `parseImportPayload`, `validateImportRows`, `writeAudit`, `Pools.imp`.

Design decisions that the tests pin down:

- **One transaction.** A partially imported file is worse than a rejected one — the admin cannot tell what landed.
- **Append-only.** No `ON CONFLICT DO UPDATE`; the role has no `UPDATE` privilege anyway. A duplicate primary key against existing data surfaces as a refusal, not a silent overwrite.
- **Audited either way.** Success and every class of failure write an `app.audit_events` row through the app pool (the import role cannot reach `app`), with `env: "live"` and `intent: { op: "import", … }`.
- **Never `data_synth`.** The schema name is a literal `data_live`; there is no env parameter to get wrong.

- [ ] **Step 1: Write the failing test**

Create `mvp/packages/broker/test/import-run.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, createPools, type Pools } from "../src/index";
import { importCollection } from "../src/import/run";
import { loadConfig } from "../src/config/load";

let p: Provisioned, admin: Pool, pools: Pools;
const cfg = loadConfig(new URL("../../../examples/meridian", import.meta.url).pathname);
const U = (n: number) => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);

beforeAll(async () => {
  p = await provision("importrun");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live, imp: p.urls.imp });
}, 60_000);
afterAll(async () => { await admin.end(); await pools.end(); await p.end(); });

const liveCount = async (t: string) =>
  Number((await admin.query(`select count(*)::int as n from data_live.${t}`)).rows[0].n);

describe("importCollection", () => {
  it("imports a CSV into data_live and reports the row count", async () => {
    const before = await liveCount("departments");
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "csv",
      text: `id,name\n${U(1)},Robotics\n${U(2)},Finance`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.imported).toBe(2);
    expect(await liveCount("departments")).toBe(before + 2);
  });

  it("imports JSON with the same result", async () => {
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "json",
      text: JSON.stringify([{ id: U(3), name: "Legal" }]),
    });
    expect(r.ok).toBe(true);
  });

  it("writes data_live and never data_synth", async () => {
    const synthBefore = Number(
      (await admin.query(`select count(*)::int as n from data_synth.departments`)).rows[0].n);
    await importCollection(pools, cfg, "ana", "departments", {
      format: "csv", text: `id,name\n${U(4)},Ops`,
    });
    const synthAfter = Number(
      (await admin.query(`select count(*)::int as n from data_synth.departments`)).rows[0].n);
    expect(synthAfter).toBe(synthBefore);
  });

  it("is atomic — one bad row imports nothing", async () => {
    const before = await liveCount("departments");
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "csv", text: `id,name\n${U(5)},Good\nnot-a-uuid,Bad`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("validation_failed");
    expect(await liveCount("departments")).toBe(before);
  });

  it("refuses a duplicate primary key against existing data without overwriting", async () => {
    await importCollection(pools, cfg, "ana", "departments", {
      format: "csv", text: `id,name\n${U(6)},Original`,
    });
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "csv", text: `id,name\n${U(6)},Overwritten`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("constraint_violation");
    const row = await admin.query(`select name from data_live.departments where id=$1`, [U(6)]);
    expect(row.rows[0].name).toBe("Original");
  });

  it("refuses a file collection", async () => {
    const r = await importCollection(pools, cfg, "ana", "policies", {
      format: "json", text: `[{"title":"x"}]`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("validation_failed");
  });

  it("refuses cleanly when no import pool is configured", async () => {
    const noImp = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live });
    const r = await importCollection(noImp, cfg, "ana", "departments", {
      format: "csv", text: `id,name\n${U(7)},X`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("import_not_configured");
    await noImp.end();
  });

  it("refuses unparseable input without throwing", async () => {
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "json", text: "{oops",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("parse_failed");
  });

  it("audits a successful import", async () => {
    const r = await importCollection(pools, cfg, "ana", "metrics", {
      format: "csv",
      text: `id,date,revenue,active_customers,region\n${U(8)},2026-01-01,100.5,10,emea`,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const ev = await admin.query(`select * from app.audit_events where id=$1`, [r.auditId]);
    expect(ev.rows[0]).toMatchObject({
      user_id: "ana", env: "live", collection: "metrics", outcome: "allowed",
    });
    expect(ev.rows[0].intent).toMatchObject({ op: "import", format: "csv", rows: 1 });
  });

  it("audits a refused import with the reason", async () => {
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "csv", text: `id,name\nbad,X`,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    const ev = await admin.query(`select * from app.audit_events where id=$1`, [r.auditId]);
    expect(ev.rows[0]).toMatchObject({
      user_id: "ana", env: "live", collection: "departments",
      outcome: "refused", reason: "validation_failed",
    });
  });

  it("never records imported values in the audit intent", async () => {
    const r = await importCollection(pools, cfg, "ana", "departments", {
      format: "csv", text: `id,name\n${U(9)},TopSecretDepartmentName`,
    });
    if (!r.ok) throw new Error("unreachable");
    const ev = await admin.query(`select intent from app.audit_events where id=$1`, [r.auditId]);
    expect(JSON.stringify(ev.rows[0].intent)).not.toContain("TopSecretDepartmentName");
  });

  it("imports a posture:deny column so real sensitive data can land and stay unreadable", async () => {
    const r = await importCollection(pools, cfg, "ana", "people", {
      format: "csv",
      text: `id,full_name,email,home_address,phone\n${U(10)},Real Person,rp@x.com,1 Main St,555-0100`,
    });
    expect(r.ok).toBe(true);
    const stored = await admin.query(`select home_address from data_live.people where id=$1`, [U(10)]);
    expect(stored.rows[0].home_address).toBe("1 Main St");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd mvp && npx vitest run packages/broker/test/import-run.test.ts
```

Expected: FAIL — cannot resolve `../src/import/run`.

- [ ] **Step 3: Implement**

Create `mvp/packages/broker/src/import/run.ts`:

```ts
import type { WarehousdConfig } from "../config/schema";
import type { Pools } from "../db/pools";
import { writeAudit } from "../audit/write";
import { parseImportPayload } from "./csv";
import { validateImportRows, type ImportError } from "./validate";

export type ImportResult =
  | { ok: true; imported: number; columns: string[]; auditId: string }
  | { ok: false; reason: string; errors?: ImportError[]; auditId: string | null };

// The single write path into data_live (SPECS §11: "deploy never writes data_live; real data
// arrives via the admin import path"). Three properties the tests pin down:
//
//   1. Atomic — a partially applied file is worse than a rejected one.
//   2. Append-only — no ON CONFLICT DO UPDATE. The role has no UPDATE privilege, so a
//      duplicate key surfaces as a refusal instead of silently rewriting real data.
//   3. Audited on every outcome, through the app pool. The import role cannot reach `app`,
//      which is deliberate: the writer of data is not the writer of its own audit trail.
export async function importCollection(
  pools: Pools,
  cfg: WarehousdConfig,
  actor: string,
  collection: string,
  payload: { text: string; format: "csv" | "json" },
): Promise<ImportResult> {
  const audit = (outcome: "allowed" | "refused", reason: string | null, extra: Record<string, unknown>) =>
    writeAudit(pools.app, {
      userId: actor, env: "live", collection,
      // Column names and counts only — never a cell value. An import file may carry real
      // personal data and the audit log is queryable by every admin.
      intent: { op: "import", format: payload.format, ...extra } as never,
      fieldsReturned: [], grantId: null, outcome, reason: reason as never,
    });

  if (!pools.imp) {
    return { ok: false, reason: "import_not_configured", auditId: null };
  }

  let rows: Record<string, unknown>[];
  try {
    rows = parseImportPayload(payload.text, payload.format);
  } catch {
    const auditId = await audit("refused", "parse_failed", { rows: 0 });
    return { ok: false, reason: "parse_failed", auditId };
  }

  const v = validateImportRows(cfg, collection, rows);
  if (!v.ok) {
    const auditId = await audit("refused", "validation_failed", { rows: rows.length });
    return { ok: false, reason: "validation_failed", errors: v.errors, auditId };
  }

  // `collection` and every column name were validated against the loaded config above, so
  // these identifiers are safe to interpolate — SQL identifiers cannot be parameterized.
  // Every VALUE is parameterized.
  const cols = v.columns.map((c) => `"${c}"`).join(", ");
  const client = await pools.imp.connect();
  try {
    await client.query("begin");
    for (const row of v.values) {
      const holes = row.map((_, i) => `$${i + 1}`).join(", ");
      await client.query(
        `insert into data_live.${collection} (${cols}) values (${holes})`, row);
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    const code = (e as { code?: string }).code;
    // 23xxx = integrity constraint violation (unique, FK, not-null, check).
    const reason = code?.startsWith("23") ? "constraint_violation" : "write_failed";
    const auditId = await audit("refused", reason, { rows: v.values.length });
    return { ok: false, reason, auditId };
  } finally {
    client.release();
  }

  const auditId = await audit("allowed", null, { rows: v.values.length, columns: v.columns });
  return { ok: true, imported: v.values.length, columns: v.columns, auditId };
}
```

Add to `mvp/packages/broker/src/index.ts`:

```ts
export { importCollection } from "./import/run";
export { validateImportRows, type ImportError } from "./import/validate";
export { parseImportPayload, parseCsv } from "./import/csv";
```

`writeAudit`'s `reason` parameter is typed `RefusalReason | null`, which does not include the import reason codes. Widen it: change the parameter type in `packages/broker/src/audit/write.ts` to `RefusalReason | string | null`, and add a comment noting that broker query refusals stay within `RefusalReason` while operational events (import, regen) carry their own codes. Remove the `as never` casts above once that lands.

- [ ] **Step 4: Run it and watch it pass**

```bash
cd mvp && npx vitest run packages/broker/test/import-run.test.ts
```

Expected: PASS, 12/12.

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/import/run.ts packages/broker/src/index.ts \
  packages/broker/src/audit/write.ts packages/broker/test/import-run.test.ts
git commit -m "feat(broker): audited, atomic, append-only import path into data_live"
```

---

## Task 21: Admin — the import surface

**Files:**
- Create: `mvp/apps/web/app/api/admin/import/route.ts`, `mvp/apps/web/app/admin/import/page.tsx`, `mvp/apps/web/app/admin/import/ImportForm.tsx`
- Test: `mvp/apps/web/test/admin-import.integration.test.ts`

**Interfaces:**
- Produces: `POST /api/admin/import` — `multipart/form-data` with `collection`, `format` and `file`; responds `{ ok: true, imported, columns }` or `{ ok: false, reason, errors? }`.
- Consumes: `importCollection`, `requireRole("admin")`.

- [ ] **Step 1: Write the failing test**

Create `mvp/apps/web/test/admin-import.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDbWithData, signIn } from "./helpers/web-db";
import { getAppPool } from "../app/lib/broker";

let db: Awaited<ReturnType<typeof setupWebDbWithData>>;
let anaCookie: string, marcusCookie: string, miaCookie: string;
const U = (n: number) => `1000000${n}-0000-4000-8000-000000000000`.slice(-36);

beforeAll(async () => {
  db = await setupWebDbWithData("adminimport");
  anaCookie = await signIn(db.auth, "ana@meridian.demo", "demo");
  marcusCookie = await signIn(db.auth, "marcus@meridian.demo", "demo");
  miaCookie = await signIn(db.auth, "mia@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

function upload(cookie: string, collection: string, text: string, format = "csv", name = "x.csv") {
  const fd = new FormData();
  fd.set("collection", collection);
  fd.set("format", format);
  fd.set("file", new File([text], name, { type: "text/csv" }));
  return new Request("http://localhost:8722/api/admin/import", {
    method: "POST", headers: { cookie }, body: fd,
  });
}

describe("POST /api/admin/import", () => {
  it("403s for a member and for a manager — import is admin-only", async () => {
    const { POST } = await import("../app/api/admin/import/route");
    expect((await POST(upload(miaCookie, "departments", `id,name\n${U(1)},X`) as any)).status).toBe(403);
    expect((await POST(upload(marcusCookie, "departments", `id,name\n${U(1)},X`) as any)).status).toBe(403);
  });

  it("imports a valid CSV and reports the count", async () => {
    const { POST } = await import("../app/api/admin/import/route");
    const res = await POST(upload(anaCookie, "departments", `id,name\n${U(2)},Imported Dept`) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, imported: 1 });
    const row = await getAppPool().query(`select name from data_live.departments where id=$1`, [U(2)]);
    expect(row.rows[0].name).toBe("Imported Dept");
  });

  it("returns per-row errors without echoing the offending values", async () => {
    const { POST } = await import("../app/api/admin/import/route");
    const res = await POST(upload(anaCookie, "departments",
      `id,name\nnot-a-uuid,Sensitive Dept Name`) as any);
    expect(res.status).toBe(400);
    const raw = await res.text();
    expect(raw).not.toContain("Sensitive Dept Name");
    const body = JSON.parse(raw);
    expect(body.reason).toBe("validation_failed");
    expect(body.errors[0]).toMatchObject({ row: 0, column: "id", reason: "invalid_uuid" });
  });

  it("rejects a missing file", async () => {
    const fd = new FormData();
    fd.set("collection", "departments");
    fd.set("format", "csv");
    const { POST } = await import("../app/api/admin/import/route");
    const res = await POST(new Request("http://localhost:8722/api/admin/import", {
      method: "POST", headers: { cookie: anaCookie }, body: fd,
    }) as any);
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("no_file");
  });

  it("rejects an unsupported format", async () => {
    const { POST } = await import("../app/api/admin/import/route");
    const res = await POST(upload(anaCookie, "departments", "x", "xlsx") as any);
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("unsupported_format");
  });

  it("rejects an oversized upload before parsing it", async () => {
    const { POST } = await import("../app/api/admin/import/route");
    const huge = "id,name\n" + `${U(3)},x\n`.repeat(400_000);
    const res = await POST(upload(anaCookie, "departments", huge) as any);
    expect(res.status).toBe(413);
    expect((await res.json()).reason).toBe("file_too_large");
  });

  it("audits the import against the acting admin", async () => {
    const { POST } = await import("../app/api/admin/import/route");
    await POST(upload(anaCookie, "departments", `id,name\n${U(4)},Audited`) as any);
    const ev = await getAppPool().query(
      `select user_id, env, collection, outcome from app.audit_events
       where intent->>'op' = 'import' order by at desc limit 1`);
    expect(ev.rows[0]).toMatchObject({
      user_id: "ana", env: "live", collection: "departments", outcome: "allowed",
    });
  });

  it("writes live regardless of the caller's env cookie", async () => {
    const { POST } = await import("../app/api/admin/import/route");
    const fd = new FormData();
    fd.set("collection", "departments");
    fd.set("format", "csv");
    fd.set("file", new File([`id,name\n${U(5)},Cookie Dev`], "x.csv"));
    const res = await POST(new Request("http://localhost:8722/api/admin/import", {
      method: "POST", headers: { cookie: `${anaCookie}; wh_env=dev` }, body: fd,
    }) as any);
    expect(res.status).toBe(200);
    const live = await getAppPool().query(`select 1 from data_live.departments where id=$1`, [U(5)]);
    const synth = await getAppPool().query(`select 1 from data_synth.departments where id=$1`, [U(5)]);
    expect(live.rowCount).toBe(1);
    expect(synth.rowCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/admin-import.integration.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the route**

Create `mvp/apps/web/app/api/admin/import/route.ts`:

```ts
import { NextRequest } from "next/server";
import { loadConfig, importCollection } from "@warehousd/broker";
import { getBroker } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";

const projectDir = process.env.WAREHOUSD_PROJECT_DIR!;
const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(req: NextRequest) {
  // Admin-only. A manager approves who may READ live data; an admin decides what live data
  // exists at all. Those are different powers and this one is the narrower.
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const form = await req.formData();
  const collection = String(form.get("collection") ?? "");
  const format = String(form.get("format") ?? "");
  const file = form.get("file");

  if (format !== "csv" && format !== "json")
    return Response.json({ ok: false, reason: "unsupported_format" }, { status: 400 });
  if (!(file instanceof File) || file.size === 0)
    return Response.json({ ok: false, reason: "no_file" }, { status: 400 });
  if (file.size > MAX_BYTES)
    return Response.json({ ok: false, reason: "file_too_large" }, { status: 413 });

  const text = await file.text();
  // env is NOT read from the cookie here: import writes data_live by definition. There is no
  // parameter that could redirect it at data_synth, and none that could redirect it away.
  const result = await importCollection(
    getBroker().pools, loadConfig(projectDir), guard.user.id, collection, { text, format });

  if (!result.ok) {
    const status = result.reason === "import_not_configured" ? 503 : 400;
    return Response.json(
      { ok: false, reason: result.reason, errors: result.errors ?? [] }, { status });
  }
  return Response.json({ ok: true, imported: result.imported, columns: result.columns });
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd mvp
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian npx vitest run apps/web/test/admin-import.integration.test.ts
```

Expected: PASS, 8/8.

- [ ] **Step 5: Build the form**

Create `mvp/apps/web/app/admin/import/ImportForm.tsx`. Three states — pick, confirm, result:

- **Pick.** A `Select` of dataset collections (from `/api/admin/collections`, `type !== "file"`), a format `Select` (CSV / JSON), and a file `Input type="file"`. Below the collection picker, render the target's expected columns from the same endpoint as a `Mono` list, marking each `required` / `nullable` and flagging `posture: deny` ones with *"stored, never readable through the broker"*. This is what stops an admin discovering their column names by trial and error.
- **Confirm.** Because this writes real data, an `AlertDialog` before submitting: *"This imports N bytes into `data_live.{collection}`. Imports are append-only — nothing already there is modified, and this cannot be undone from the UI."*
- **Result.** On success, `toast.success` plus a summary card (rows imported, columns). On `validation_failed`, a bordered error panel listing `row · column · reason` in `font-mono text-xs`, capped with *"showing the first 50 problems"*. Render the reason codes through a small label map (`invalid_uuid` → "not a UUID", `missing_required` → "required value missing", `unknown_term` → "not a term in the bound vocabulary", `duplicate_pk` → "duplicate primary key in this file", `constraint_violation` → "conflicts with data already in the collection"), and state plainly that **nothing was imported**.

Create `mvp/apps/web/app/admin/import/page.tsx`:

```tsx
import { PageHeader } from "@/components/common/PageHeader";
import { ImportForm } from "./ImportForm";

export default function ImportPage() {
  return (
    <>
      <PageHeader
        title="Import live data"
        description="The only write path into data_live. Rows are validated against warehousd.yml, written by a role that cannot read them back, and audited."
      />
      <ImportForm />
    </>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/api/admin/import apps/web/app/admin/import \
  apps/web/test/admin-import.integration.test.ts
git commit -m "feat(web): admin live-data import surface"
```

---

## Task 22: Leak probes over imported live data

**Files:**
- Modify: `mvp/packages/broker/test/fixtures/canaries.ts`
- Create: `mvp/packages/broker/test/import-probe.test.ts`
- Test: as above

**Interfaces:**
- Produces: `IMPORT_CANARY` and `IMPORT_DENIED_CANARY` exported from the canaries fixture.
- Consumes: `importCollection`, `makeBroker`, the existing `probes.json` fixture.

The acceptance gate requires *"leak probes cover imported live data (canary discipline)"*. Imported rows are the only rows in the system that are simultaneously real-shaped, live, and reachable — exactly the case the probe suite exists for. The probes themselves are data-driven (`probes.json`, per SPECS §14), so this task plants canaries through the import path and reruns the existing hostile intents against them.

- [ ] **Step 1: Add the canaries**

Read `mvp/packages/broker/test/fixtures/canaries.ts` and append, matching its existing style:

```ts
// Planted through the admin import path (Phase 5) rather than the seeders — imported live
// rows are the only real-shaped data in the system, so the probe suite must cover them.
export const IMPORT_CANARY = "CANARY_IMPORTED_LIVE_5d7e";          // people.full_name (live, imported)
export const IMPORT_DENIED_CANARY = "CANARY_IMPORTED_DENIED_8b2f"; // people.home_address (posture: deny)
```

- [ ] **Step 2: Write the failing test**

Create `mvp/packages/broker/test/import-probe.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { provision, type Provisioned } from "./helpers/db";
import { createAppSchema, applyConfig, makeBroker, createPools, type Pools } from "../src/index";
import { importCollection } from "../src/import/run";
import { loadConfig } from "../src/config/load";
import { IMPORT_CANARY, IMPORT_DENIED_CANARY } from "./fixtures/canaries";

let p: Provisioned, admin: Pool, pools: Pools, broker: ReturnType<typeof makeBroker>;
const cfg = loadConfig(new URL("../../../examples/meridian", import.meta.url).pathname);
const PERSON = "9a000001-0000-4000-8000-000000000001";
const ctx = { userId: "mia", env: "live" as const };

beforeAll(async () => {
  p = await provision("importprobe");
  admin = new Pool({ connectionString: p.urls.admin });
  await createAppSchema(admin);
  await applyConfig(admin, cfg);
  pools = createPools({ app: p.urls.admin, dev: p.urls.dev, live: p.urls.live, imp: p.urls.imp });
  broker = makeBroker(pools, cfg);

  // Plant the canaries through the real import path — not a direct INSERT. If the import
  // path itself is the leak, this test must see it.
  const r = await importCollection(pools, cfg, "ana", "people", {
    format: "csv",
    text: `id,full_name,email,home_address,phone\n` +
          `${PERSON},${IMPORT_CANARY},canary@x.test,${IMPORT_DENIED_CANARY},555-0000`,
  });
  if (!r.ok) throw new Error(`fixture import failed: ${r.reason}`);

  // Mia gets a live grant that excludes home_address and phone (both posture: deny anyway).
  await admin.query(
    `insert into app.grants (user_id,collection,env,status,allowed_fields,expires_at)
     values ('mia','people','live','approved',
             array['id','full_name','email'], now() + interval '1 day')`);
}, 60_000);
afterAll(async () => { await admin.end(); await pools.end(); await p.end(); });

const probes: { name: string; intent: any; expect: string }[] =
  JSON.parse(readFileSync(new URL("./fixtures/probes.json", import.meta.url), "utf8"));

describe("imported live data is subject to the same enforcement as seeded data", () => {
  it("a granted field imported through the admin path is readable", async () => {
    const r = await broker.query(ctx, { collection: "people", fields: ["full_name"] });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(JSON.stringify(r.documents)).toContain(IMPORT_CANARY);
  });

  it("the imported posture:deny value is absent from an unfielded query", async () => {
    const r = await broker.query(ctx, { collection: "people" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    for (const row of r.documents) expect("home_address" in row).toBe(false);
    expect(JSON.stringify(r.documents)).not.toContain(IMPORT_DENIED_CANARY);
  });

  it("asking for the imported denied field is refused, and the refusal says nothing", async () => {
    const r = await broker.query(ctx, { collection: "people", fields: ["home_address"] });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(IMPORT_DENIED_CANARY);
  });

  it("filtering on the imported denied field is refused", async () => {
    const r = await broker.query(ctx, {
      collection: "people", fields: ["id"],
      filters: [{ field: "home_address", op: "eq", value: IMPORT_DENIED_CANARY }],
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(IMPORT_DENIED_CANARY);
  });

  it("the full hostile-intent suite leaks no imported denied value", async () => {
    for (const probe of probes) {
      const intent = { ...probe.intent, collection: "people" };
      let out: unknown;
      try { out = await broker.query(ctx, intent as never); }
      catch (e) { out = { error: String(e) }; }
      expect(JSON.stringify(out), `probe: ${probe.name}`).not.toContain(IMPORT_DENIED_CANARY);
    }
  });

  it("a dev-context caller sees no imported live value at all", async () => {
    await admin.query(
      `insert into app.grants (user_id,collection,env,status,allowed_fields)
       values ('mia','people','dev','approved', array['id','full_name','email'])`);
    const r = await broker.query({ userId: "mia", env: "dev" }, { collection: "people" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    const body = JSON.stringify(r.documents);
    expect(body).not.toContain(IMPORT_CANARY);
    expect(body).not.toContain(IMPORT_DENIED_CANARY);
  });

  it("every probe above is audited", async () => {
    const n = await admin.query(
      `select count(*)::int as n from app.audit_events where user_id='mia' and collection='people'`);
    expect(n.rows[0].n).toBeGreaterThan(probes.length);
  });
});
```

- [ ] **Step 3: Run it**

```bash
cd mvp && npx vitest run packages/broker/test/import-probe.test.ts
```

Expected: PASS. **If any assertion fails, that is a real leak — stop and fix the broker, not the test.** The most likely genuine failure is the probe loop hitting an intent shape `people` does not support; in that case skip probes whose `intent.collection` is meaningfully different rather than deleting the assertion.

If `probes.json`'s shape does not match the destructuring above, read the file and adapt the loop — it is the source of truth.

- [ ] **Step 4: Commit**

```bash
git add packages/broker/test/fixtures/canaries.ts packages/broker/test/import-probe.test.ts
git commit -m "test(broker): leak probes over data planted through the admin import path"
```

---

## Task 23: Playwright — the surfaces in a real browser

**Files:**
- Create: `mvp/apps/web/playwright.config.ts`, `mvp/apps/web/e2e/{guards,grant-lifecycle}.spec.ts`, `mvp/scripts/e2e-setup.ts`
- Modify: `mvp/package.json` (scripts), `mvp/.gitignore`
- Test: as above

**Interfaces:**
- Produces: `pnpm e2e` — provisions a disposable database, boots `next dev` against it, and runs the browser suite.
- Consumes: everything built so far.

Route-handler tests prove the *rules*. They cannot prove a member never sees an admin link, that a redirect actually happens, or that the approve sheet posts what it renders. That is what this task covers — deliberately two specs, not twenty.

- [ ] **Step 1: Install Playwright**

```bash
cd mvp
pnpm --filter @warehousd/web add -D @playwright/test@^1.62.0
npx playwright install chromium
```

- [ ] **Step 2: The fixture database script**

Create `mvp/scripts/e2e-setup.ts` — it is `dev-bootstrap.ts` against a dedicated database so an e2e run never disturbs the manual demo data:

```ts
// Provisions `warehousd_e2e` from scratch: schemas, the four roles, YAML apply, synthetic
// data, indexed policies, and the three personas. Idempotent — drops and recreates.
import { Pool } from "pg";
import { execSync } from "node:child_process";

const ADMIN = "postgres://postgres:postgres@127.0.0.1:54330/postgres";
const DB = "warehousd_e2e";

async function main() {
  const a = new Pool({ connectionString: ADMIN });
  await a.query(`drop database if exists ${DB} with (force)`);
  await a.query(`create database ${DB}`);
  await a.end();

  process.env.APP_DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:54330/${DB}`;
  process.env.DEV_DATABASE_URL = `postgres://warehousd_dev:pw@127.0.0.1:54330/${DB}`;
  process.env.LIVE_DATABASE_URL = `postgres://warehousd_live:pw@127.0.0.1:54330/${DB}`;
  process.env.IMPORT_DATABASE_URL = `postgres://warehousd_import:pw@127.0.0.1:54330/${DB}`;

  execSync("pnpm tsx scripts/dev-bootstrap.ts", { stdio: "inherit", env: process.env });
  console.log(`e2e database ready: ${DB}`);
}
main();
```

- [ ] **Step 3: Playwright config**

Create `mvp/apps/web/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const DB = "postgres://postgres:postgres@127.0.0.1:54330/warehousd_e2e";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false, // one database, one dev server
  workers: 1,
  use: { baseURL: "http://localhost:8722", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:8722/login",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      APP_DATABASE_URL: DB,
      DEV_DATABASE_URL: "postgres://warehousd_dev:pw@127.0.0.1:54330/warehousd_e2e",
      LIVE_DATABASE_URL: "postgres://warehousd_live:pw@127.0.0.1:54330/warehousd_e2e",
      IMPORT_DATABASE_URL: "postgres://warehousd_import:pw@127.0.0.1:54330/warehousd_e2e",
      WAREHOUSD_PROJECT_DIR: resolve(__dirname, "../../examples/meridian"),
      WAREHOUSD_DEMO: "true",
    },
  },
});
```

Vitest's `include` is `apps/**/test/**/*.test.ts`, so `apps/web/e2e/*.spec.ts` is invisible to it. Confirm with `npx vitest list | grep e2e` — expected: no output.

- [ ] **Step 4: The guard spec**

Create `mvp/apps/web/e2e/guards.spec.ts`:

```ts
import { test, expect, type Page } from "@playwright/test";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByPlaceholder("email").fill(email);
  await page.getByPlaceholder("password").fill("demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

test.describe("role-scoped surfaces", () => {
  test("a member lands on /member and sees only member navigation", async ({ page }) => {
    await signIn(page, "mia@meridian.demo");
    await expect(page).toHaveURL(/\/member$/);
    await expect(page.getByRole("link", { name: "My grants" })).toBeVisible();
    await expect(page.getByRole("link", { name: "How to connect" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Users & roles" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Grant inbox" })).toHaveCount(0);
  });

  test("a member navigating to /admin is redirected to 403", async ({ page }) => {
    await signIn(page, "mia@meridian.demo");
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/403$/);
    await expect(page.getByText("You don't have access to this area")).toBeVisible();
  });

  test("a member navigating to /manager is redirected to 403", async ({ page }) => {
    await signIn(page, "mia@meridian.demo");
    await page.goto("/manager");
    await expect(page).toHaveURL(/\/403$/);
  });

  test("a manager reaches /manager but not /admin", async ({ page }) => {
    await signIn(page, "marcus@meridian.demo");
    await expect(page).toHaveURL(/\/manager$/);
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/403$/);
  });

  test("an admin reaches every surface", async ({ page }) => {
    await signIn(page, "ana@meridian.demo");
    await expect(page).toHaveURL(/\/admin$/);
    for (const path of ["/admin/collections", "/admin/users", "/admin/clients",
                        "/admin/sso", "/admin/audit", "/admin/import"]) {
      await page.goto(path);
      await expect(page).not.toHaveURL(/\/403$/);
    }
  });

  test("an unauthenticated visitor is sent to login from every surface", async ({ page, context }) => {
    await context.clearCookies();
    for (const path of ["/", "/admin", "/manager", "/member"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    }
  });

  test("the env switcher persists across a reload", async ({ page }) => {
    await signIn(page, "ana@meridian.demo");
    await page.getByRole("group", { name: "Environment" }).getByText("live").click();
    await page.reload();
    await expect(
      page.getByRole("group", { name: "Environment" }).getByText("live")
    ).toHaveAttribute("aria-pressed", "true");
  });
});
```

- [ ] **Step 5: The lifecycle spec**

Create `mvp/apps/web/e2e/grant-lifecycle.spec.ts` — §10 test 7, through the actual interface:

```ts
import { test, expect, type Page } from "@playwright/test";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByPlaceholder("email").fill(email);
  await page.getByPlaceholder("password").fill("demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: /@meridian\.demo/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/);
}

test("request → approve with trimmed fields → revoke, all through the UI", async ({ page }) => {
  // 1. Mia requests access to departments.
  await signIn(page, "mia@meridian.demo");
  await page.getByRole("button", { name: "Request access" }).click();
  await page.getByLabel("Collection").click();
  await page.getByRole("option", { name: "departments" }).click();
  await page.getByLabel("Purpose").fill("org chart");
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByText("Access requested")).toBeVisible();
  await expect(page.getByRole("row", { name: /departments/ })).toContainText("Pending");
  await signOut(page);

  // 2. Marcus sees it, trims to one field, sets no expiry, approves.
  await signIn(page, "marcus@meridian.demo");
  const row = page.getByRole("row", { name: /mia.*departments/ });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Review" }).click();
  await page.getByRole("checkbox", { name: "id" }).uncheck();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Grant approved")).toBeVisible();
  await signOut(page);

  // 3. Mia sees an approved grant scoped to the single remaining field.
  await signIn(page, "mia@meridian.demo");
  const mine = page.getByRole("row", { name: /departments/ });
  await expect(mine).toContainText("Approved");
  await expect(mine).toContainText("name");
  await expect(mine).not.toContainText("id,");
  await signOut(page);

  // 4. Marcus revokes it.
  await signIn(page, "marcus@meridian.demo");
  await page.getByRole("link", { name: "Active grants" }).click();
  const active = page.getByRole("row", { name: /mia.*departments/ });
  await active.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("button", { name: "Revoke", exact: true }).last().click();
  await signOut(page);

  // 5. Mia's grant is revoked, and the audit browser has the whole story for Ana.
  await signIn(page, "mia@meridian.demo");
  await expect(page.getByRole("row", { name: /departments/ })).toContainText("Revoked");
  await signOut(page);

  await signIn(page, "ana@meridian.demo");
  await page.getByRole("link", { name: "Audit" }).click();
  await page.getByLabel("Collection").click();
  await page.getByRole("option", { name: "departments" }).click();
  await expect(page.getByRole("row").filter({ hasText: "deny" }).first()).toBeVisible();
});
```

Element queries above assume accessible names from `building-product-ui` patterns (`FormLabel`, `aria-label`, `role="status"`). If a selector does not resolve, **fix the component's accessibility rather than switching to a CSS selector** — an element Playwright cannot name is an element a screen reader cannot name either.

- [ ] **Step 6: Scripts and ignores**

Add to `mvp/package.json`:

```json
    "e2e:setup": "tsx scripts/e2e-setup.ts",
    "e2e": "pnpm e2e:setup && pnpm --filter @warehousd/web exec playwright test",
    "e2e:ui": "pnpm --filter @warehousd/web exec playwright test --ui"
```

Add to `mvp/.gitignore`:

```
apps/web/test-results/
apps/web/playwright-report/
```

- [ ] **Step 7: Run it**

```bash
cd mvp
pnpm test:up
ANTHROPIC_API_KEY=unused pnpm e2e
```

Expected: 8/8 green. Iterate on selectors and component accessible names until it is. A flaky wait is a bug — use `expect(...).toBeVisible()` (auto-retrying), never `waitForTimeout`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/playwright.config.ts apps/web/e2e scripts/e2e-setup.ts \
  package.json .gitignore apps/web/package.json pnpm-lock.yaml
git commit -m "test(web): playwright coverage for role guards and the grant lifecycle"
```

---

## Task 24: Design review pass

**Files:**
- Modify: whatever the review turns up
- Test: none (visual + checklist)

**Interfaces:**
- Produces: screenshots of all eleven surfaces and a fixed set of findings.

- [ ] **Step 1: Boot the app with demo data**

```bash
cd mvp
pnpm test:up
pnpm e2e:setup
WAREHOUSD_DEMO=true \
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian \
APP_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54330/warehousd_e2e \
DEV_DATABASE_URL=postgres://warehousd_dev:pw@127.0.0.1:54330/warehousd_e2e \
LIVE_DATABASE_URL=postgres://warehousd_live:pw@127.0.0.1:54330/warehousd_e2e \
IMPORT_DATABASE_URL=postgres://warehousd_import:pw@127.0.0.1:54330/warehousd_e2e \
  pnpm --filter @warehousd/web dev
```

- [ ] **Step 2: Screenshot every surface**

Using the Playwright MCP tools (`browser_navigate`, `browser_take_screenshot`), capture, signed in as the right persona for each: `/member`, `/member/connect`, `/manager`, `/manager/grants`, `/admin`, `/admin/collections`, `/admin/users`, `/admin/clients`, `/admin/sso`, `/admin/audit`, `/admin/import`, `/console`, `/403`, `/login`.

Also capture the four modal surfaces: the request sheet, the approve sheet, the new-client dialog (both states), and the import error panel.

- [ ] **Step 3: Walk the `building-product-ui` checklist against each screenshot**

For every surface confirm:

- Semantic tokens only — grep for violations: `grep -rn 'bg-white\|bg-gray-\|text-gray-\|bg-zinc-\|text-black' apps/web/app apps/web/components | grep -v node_modules` must return nothing.
- All four states exist: empty (`EmptyState`), loading (`Skeleton`), populated, error. Force each: sign in as a brand-new user for empty; throttle the network for loading; stop Postgres for error.
- Every form field has a `Label`; every destructive action is an `AlertDialog`; every complex form is a `Sheet`.
- Icon-only buttons have `aria-label` **and** a `Tooltip`.
- Status is never colour alone — `StatusBadge` has a dot + label, `OutcomeBadge` a glyph + label.
- Tab order reaches every control; the focus ring is visible on all of them.
- Async actions produce a toast.

- [ ] **Step 4: Check the console-specific requirements (SPECS §14)**

- The audit browser is visually the most prominent admin surface, not a buried table.
- Every id, collection name, field list, scope, path and intent renders in `font-mono`.
- Allow/deny reads correctly in greyscale — screenshot the audit table, desaturate it, and confirm the two outcomes remain distinguishable.

- [ ] **Step 5: Fix what the pass found, then re-screenshot the affected surfaces**

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "polish(web): design review pass across the three surfaces"
```

---

## Task 25: Documentation and the acceptance gate

**Files:**
- Modify: `docs/TESTING.md`, `docs/SETUP.md`, `docs/MVP-ROADMAP.md`, `docs/superpowers/plans/2026-07-20-phase-5-web-ui.md`
- Create: `docs/superpowers/plans/2026-07-25-phase-5-web-ui.md` (this plan)

- [ ] **Step 1: Land the plan in the repo**

Copy this file to `docs/superpowers/plans/2026-07-25-phase-5-web-ui.md`, and replace the body of the old outline with a single pointer line to it.

- [ ] **Step 2: Document the new environment variables**

Append to `docs/SETUP.md` a row for `IMPORT_DATABASE_URL` (`postgres://warehousd_import:pw@…`) explaining that it is optional, that its absence means no write path into `data_live`, and that the role holds `INSERT` only. Update the run commands in that file to include it.

- [ ] **Step 3: Extend the manual runbook**

Append to `docs/TESTING.md` (which currently stops at §11) new numbered sections:

- **12. Role-scoped surfaces.** Sign in as each persona; confirm the landing route, the nav contents, and that typing `/admin` as Mia lands on 403.
- **13. Grant lifecycle through the UI.** The Task 23 lifecycle spec, by hand, ending in the audit browser filtered to the collection.
- **14. Document-scoped approval (the Task 9 regression).** Approve Mia's `policies` request scoped to `hr`, then in `/console` ask *"what is the expense reimbursement policy?"* — expect no results — and *"what is the remote work policy?"* — expect content. **Before Phase 5 this scoping was silently dropped; this is the check that it is not.**
- **15. Client promotion.** Create a client as Ana, confirm `env:dev` only, promote as Marcus, confirm the trail shows `marcus` and a timestamp, demote, confirm scopes narrow.
- **16. Live import.** Import a two-row CSV into `departments`; confirm the audit event; re-import the same file and confirm `constraint_violation` with nothing written; import a file with a bad UUID and confirm the error panel names the row and column but never the values.
- **17. Regenerate dev data.** Note a synthetic row, regenerate with a new seed, confirm it changed and that a `data_live` row you imported did not.

- [ ] **Step 4: Update the roadmap**

In `docs/MVP-ROADMAP.md`: tick every Phase 5 checkbox, mark the section `— ✅ COMPLETE`, add the plan link to the phase table, and add a **Try it yourself** block matching the Phase 0.5 / 0.6 style (automated commands + a manual walk-through of the three surfaces and the import path). Change the §10 mapping row for test 7 from "Phase 0 (through real UI in 5)" to note that Phase 5 now drives it through the UI/API layer and in a browser.

- [ ] **Step 5: The full gate**

```bash
cd mvp
pnpm test:down && pnpm test:up
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian pnpm test 2>&1 | tail -30
pnpm lint
cd apps/web && npx tsc --noEmit && npx next build
cd .. && cd .. && pnpm e2e
```

Every one of these must pass:

- Vitest: strictly more tests than the Task 0 baseline, zero failures.
- ESLint: clean, including the `no-restricted-imports` rule on `packages/broker` (the new `import/` module must not have pulled in anything HTTP-shaped).
- `tsc --noEmit`: clean.
- `next build`: succeeds — a page that only fails in a production build is a page that only fails in production.
- Playwright: 8/8.

- [ ] **Step 6: Verify the acceptance gate line by line**

| Gate (from the Phase 5 outline) | Evidence |
|---|---|
| Route-level authorization tests: each surface 403s for lower roles | `route-guards.integration.test.ts` (matrix) + `guards.spec.ts` (browser) + per-route 403 tests in every admin/manager suite |
| §10 test 7 driven end-to-end through the UI/API layer | `grant-lifecycle-ui.integration.test.ts` + `grant-lifecycle.spec.ts` |
| Promotion/demotion through the UI drives the Phase 2 scope tests | `admin-clients.integration.test.ts` + the untouched `oauth-scope`/`oauth-refresh` suites |
| Import: schema validation rejects bad rows | `import-validate.test.ts` (20 cases) + `admin-import.integration.test.ts` |
| Import: every import audited | `import-run.test.ts` (success + refusal) + `admin-import.integration.test.ts` |
| Import: leak probes cover imported live data | `import-probe.test.ts` |
| Manual design review pass | Task 24 |
| All prior tests green | Step 5 |

- [ ] **Step 7: Commit and open the PR**

```bash
git add docs
git commit -m "docs: phase 5 plan, runbook and roadmap"
gh pr create --base main --title "Phase 5: Admin / Manager / Member web UI + live import path" --body "$(cat <<'EOF'
## Summary

Replaces the single Phase 0 console screen with three role-scoped surfaces on Tailwind v4 + shadcn/ui, and adds the admin import path — the only write into `data_live`.

- `/admin` — collections & postures with apply status, users & roles, OAuth clients (scopes, promotion trail, last token), SSO configuration, audit browser with filters, live-data import, regenerate dev data
- `/manager` — grant inbox with field trimming, expiry and document scoping; active grants with revoke
- `/member` — my grants with effective status, request access, how-to-connect
- `/console` — the chat bench, now dev-mode only
- `warehousd_import` — a fourth Postgres role with `INSERT` and nothing else on `data_live`

## Defects fixed

- **Approvals silently dropped their document filter.** The route wrote `opts.rowFilter`; `approveGrant` reads `opts.documentFilter`. A manager scoping a grant to two files was granting the whole collection. `selectedTerms` was never read at all.
- **Members could not request access from the UI** — the `action: "request"` branch was empty.
- **`GET /api/grants` disclosed the whole pending queue to any authenticated user.**
- **`GET /api/audit` returned every event in the deployment to any authenticated user.**
- **`/api/grants/doc-paths` queried a data schema directly from a route on the owner pool**, breaking the broker-only invariant.

## Testing

- Vitest: route-handler integration tests for every new endpoint, per-role 401/403, §10 test 7 through the real routes
- Playwright: role guards and the full grant lifecycle in a browser
- Broker: import role privileges, validation, atomicity, audit, and leak probes over imported live data

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

**Spec coverage**

| Requirement | Task |
|---|---|
| §8 Admin — collections & postures (read-only YAML + apply status) | 12 |
| §8 Admin — SSO configuration | 16 |
| §8 Admin — user roles | 13 |
| §8 Admin — regenerate synthetic data | 17 |
| §8 Admin — audit browser (filter by user/collection/outcome) | 14 |
| §8 Manager — inbox, approve with expiry + trimmed fields, deny | 10 |
| §8 Manager — active grants with revoke | 11 |
| §8 Member — my grants + statuses | 6 |
| §8 Member — how-to-connect | 8 |
| §6.1 Admin → Clients: list, new client (`{env:dev}` always) | 15 |
| §6.1 per-client scopes, promotion trail, last token, demote | 15 |
| §11 real data via the admin import path | 18–21 |
| §5.6.4 document_filter authored at approval time | 9 |
| §10 test 7 grant lifecycle through the UI | 11, 23 |
| §10 test 4 leak probes extended to imported data | 22 |
| §10 test 9 audit completeness for new operations | 17, 20 |
| §14 security-console aesthetic, monospace, non-colour allow/deny | 1, 2, 24 |
| Navigation/layout, chat console as a dev-mode page | 4, 5 |

**Deferred, deliberately**

- **No posture editing in the UI.** §8 says *read-only view of YAML state*; governance lives in git (§5.3). The collections screen tells you to run `warehousd apply`; it does not offer a button.
- **No `warehousd apply` from the UI.** Same reason. It belongs to the CLI (Phase 6) and to `deploy` (Phase 7).
- **No file-collection import.** `type: file` collections are ingested by the indexer, which owns chunking, checksums and deletion sync. Upload UI for documents is explicitly post-MVP (§12).
- **No `ON CONFLICT DO UPDATE` on import.** Append-only is the whole point of an `INSERT`-only role; an update path needs its own design and its own audit semantics.
- **No IdP group→role mapping** on the users screen — documented as post-MVP in §6 item 3.

**Cross-task consistency checks performed**

- `requireRole(req, role)` returns `{ok, user}` / `{ok, response}` and is used with that exact shape in Tasks 6–21.
- `AppShell` takes `surface` *and* `role` (settled in Task 4 Step 4) and is called that way in Task 5.
- `Pools.imp` is `Pool | null` in Task 18 and null-checked in Task 20.
- `buildApproval` (Task 9) is the only producer of `documentFilter`; `approveGrant`'s existing signature is unchanged.
- `regenerateSynthetic` (Task 17) is consumed by the CLI, the bootstrap script and the admin route.
- `listDocumentPaths` (Task 10) is consumed by `doc-paths/route.ts` and by the approve sheet.
- `ImportError` is produced in Task 19, threaded through Task 20's `ImportResult`, and rendered in Task 21.

**Known risks the executor should watch**

1. **Task 15 Step 1 is a discovery step, not a formality.** If `oauthAccessToken`'s columns differ from what is written here, the `lastTokenAt` subquery fails at runtime and nothing in `tsc` will catch it.
2. **Task 18 Step 6** names the one plausible Postgres-version-dependent outcome (FK checks needing SELECT) and its narrow fix. Do not resolve it by granting blanket SELECT.
3. **Task 15 Step 5 knowingly breaks an existing test** (`oauth-clients.integration.test.ts` asserts a member may create a client). The fix is specified; do not skip the file.
4. **Task 19's test expectations encode assumptions about `examples/meridian/warehousd.yml`** (which fields are nullable, which are `posture: deny`). Read the YAML and correct the *test*, never the validator.
