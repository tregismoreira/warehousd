# Dev Setup Guide

## Prerequisites

- Node.js 20+, pnpm 9+
- Docker (for Postgres)
- An Anthropic API key

## 1. Install dependencies

```bash
cd mvp
pnpm install
```

## 2. Start Postgres

There is no dev docker-compose yet — use the test one or run your own Postgres instance with the pgvector extension (`pgvector/pgvector:pg16`).

Quick option (reuses the test container):

```bash
cd mvp
pnpm test:up   # starts postgres on 127.0.0.1:5432 mapped from port 54330
```

Or run a standalone dev container:

```bash
docker run -d \
  --name warehousd-dev \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=warehousd \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

## 3. Set environment variables

Create `mvp/apps/web/.env.local`:

```bash
# Postgres — the main app schema (user/session/grants/collections)
APP_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/warehousd

# Per-env data (broker queries run against these)
DEV_DATABASE_URL=postgres://warehousd_dev:pw@127.0.0.1:5432/warehousd
LIVE_DATABASE_URL=postgres://warehousd_live:pw@127.0.0.1:5432/warehousd

# Better Auth
BETTER_AUTH_SECRET=any-random-string-at-least-32-chars-long
BETTER_AUTH_URL=http://localhost:8722

# Anthropic (for chat)
ANTHROPIC_API_KEY=sk-ant-...

# Demo mode — shows demo credential buttons on the login screen
WAREHOUSD_DEMO=true

# Kill-switch — uncomment to disable local login (shows SSO notice instead)
# WAREHOUSD_DISABLE_LOCAL_LOGIN=true
```

> `NEXT_PUBLIC_*` variants are derived automatically from the non-public ones via `next.config.mjs` — you don't need to set them.

## 4. Bootstrap the database

Run once against a fresh database. Seeds schemas, roles, synthetic data, demo docs, and the three demo users.

```bash
cd mvp
APP_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/warehousd \
BETTER_AUTH_SECRET=any-random-string-at-least-32-chars-long \
BETTER_AUTH_URL=http://localhost:8722 \
WAREHOUSD_PROJECT_DIR=examples/meridian \
npx tsx scripts/dev-bootstrap.ts
```

The script is idempotent — safe to re-run on container restart.

## 5. Start the web app

```bash
cd mvp
WAREHOUSD_DEMO=true \
WAREHOUSD_PROJECT_DIR=examples/meridian \
pnpm --filter @warehousd/web dev
```

App is available at **http://localhost:8722**.

## Demo credentials

| Email | Password | Role |
|---|---|---|
| `ana@meridian.demo` | `demo` | admin |
| `marcus@meridian.demo` | `demo` | manager |
| `mia@meridian.demo` | `demo` | member |

## Run the test suite

```bash
cd mvp
pnpm test:up   # start test postgres (port 54330)
WAREHOUSD_PROJECT_DIR=examples/meridian pnpm test
```
