# Contributing to warehousd

Thanks for wanting to help. This file is for people changing warehousd itself. If you only want to *use* warehousd in your own project, you never need to clone this repo — see the [CLI reference](docs/cli.md).

## Ground rules

- **The broker is the trust boundary.** `packages/broker` must stay free of HTTP, MCP, UI, and LLM imports (an ESLint rule enforces this). No code outside the broker may read collection tables.
- **Every security invariant has a test.** If you touch enforcement — postures, grants, env isolation, SQL construction, audit — the pull request must carry a test that fails without your change. See [docs/architecture.md](docs/architecture.md) for the invariants.
- **Denied means absent.** A denied field must never appear in a response, an error message, or a log line. When in doubt, add a canary to the fixtures and grep for it.

## Prerequisites

- macOS or Linux. Windows is not supported yet — see [docs/roadmap.md](docs/roadmap.md).
- Node.js 22+
- pnpm 10+ (`corepack enable`)
- Docker (for Postgres, and for the CLI end-to-end tests).

## 1. Install

```bash
pnpm install
```

## 2. Start Postgres

There is no separate dev database — reuse the test container:

```bash
pnpm test:up   # pgvector/pgvector:pg16 on 127.0.0.1:54330
```

Or run your own Postgres 16 with the `pgvector` extension available.

## 3. Configure the web app

Copy `apps/web/.env.example` to `apps/web/.env.local` — it already contains the block below:

```bash
# The app schema: users, sessions, grants, collections, audit
APP_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54330/warehousd

# Per-env data roles — broker queries run through exactly one of these
DEV_DATABASE_URL=postgres://warehousd_dev:pw@127.0.0.1:54330/warehousd
LIVE_DATABASE_URL=postgres://warehousd_live:pw@127.0.0.1:54330/warehousd

# The admin import path's write role — INSERT-only on data_live. Optional: if unset,
# POST /api/admin/import refuses with `import_not_configured` and there is no write
# path into data_live at all.
IMPORT_DATABASE_URL=postgres://warehousd_import:pw@127.0.0.1:54330/warehousd

# Better Auth
BETTER_AUTH_SECRET=any-random-string-at-least-32-chars-long
BETTER_AUTH_URL=http://localhost:8722

# Comma-separated origins trusted as OIDC/SAML issuers. Required for any
# loopback/private-network IdP — see docs/configure-sso.md. Leave unset otherwise.
WAREHOUSD_TRUSTED_ORIGINS=

# Seeds the three demo personas and shows their buttons on the login screen
WAREHOUSD_DEMO=true

# Kill switch — uncomment to disable local login entirely (SSO only)
# WAREHOUSD_DISABLE_LOCAL_LOGIN=true
```

`NEXT_PUBLIC_*` variants are derived from these in `next.config.mjs`; you don't set them yourself.

## 4. Bootstrap the database

Run once against a fresh database. It is idempotent — safe to re-run.

```bash
APP_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54330/warehousd \
DEV_DATABASE_URL=postgres://warehousd_dev:pw@127.0.0.1:54330/warehousd \
LIVE_DATABASE_URL=postgres://warehousd_live:pw@127.0.0.1:54330/warehousd \
IMPORT_DATABASE_URL=postgres://warehousd_import:pw@127.0.0.1:54330/warehousd \
BETTER_AUTH_SECRET=any-random-string-at-least-32-chars-long \
BETTER_AUTH_URL=http://localhost:8722 \
WAREHOUSD_PROJECT_DIR=examples/harbor \
npx tsx scripts/dev-bootstrap.ts
```

This seeds schemas and roles, synthetic data, the demo documents, the three demo personas, and Mia's pending grant request — the state the demo arc starts from. The container entrypoint (`apps/web/scripts/entrypoint.ts`) does most of the same work for consumers; `dev-bootstrap.ts` adds the pending request and a populated live environment for testing.

## 5. Run the app

```bash
WAREHOUSD_DEMO=true \
WAREHOUSD_PROJECT_DIR=examples/harbor \
pnpm --filter @warehousd/web dev
```

http://localhost:8722 — sign in as `ana@demo.local` (admin), `marcus@demo.local` (manager), or `mia@demo.local` (member), password `demo`.

## Before you open a pull request

```bash
pnpm lint                                           # ESLint, type-checked rules
pnpm typecheck                                      # src + test + e2e + scripts
pnpm format:check                                   # Prettier, code only
WAREHOUSD_PROJECT_DIR=examples/harbor pnpm test     # unit + integration
pnpm build                                          # production build
pnpm e2e                                            # Playwright, real browser
```

All six must be clean. `pnpm test` does not typecheck — vitest transpiles without checking — so `pnpm typecheck` is the one that catches a type error, and it covers `test/`, `e2e/` and `scripts/` as well as `src`. `pnpm format` rewrites; prose is deliberately out of scope (see `.prettierignore`).

Details and the slower suites (CLI end-to-end, Keycloak SSO) are in [docs/testing.md](docs/testing.md).

Then:

- One focused change per pull request; describe what invariant or behavior it affects.
- Use the terminology in [docs/glossary.md](docs/glossary.md) — collection, document, field. Not table, row, item.
- Run `pnpm spec` if you touched a `/v1` route, an intent schema, or an MCP tool, and commit the regenerated `docs/openapi.json` / `docs/mcp-tools.json` — `pnpm test` fails otherwise, since both are checked against the code that generates them.
- Do not report security vulnerabilities through a pull request or issue. See [SECURITY.md](SECURITY.md).

## Repository layout

```
apps/web/            Next.js — UI, MCP and REST adapters, auth routes; published as the Docker image
packages/broker/     the core: grants, query validation, synthetic data, indexing, YAML loader
packages/providers/  optional heavy deps behind broker interfaces — embedder, PDF/DOCX, XLSX
packages/cli/        the published `warehousd` npm CLI
examples/harbor/     a complete consuming project (the demo company)
scripts/             contributor bootstrap and e2e setup
test/                shared fixtures (Keycloak realm for the SSO suite)
docs/                user and contributor documentation
.github/assets/      diagrams — read the style guide there before adding one
```
