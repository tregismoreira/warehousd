# Warehousd Phase 0 POC

**⚠️ Phase 0 has NO AUTHENTICATION. `docker compose up` binds to `127.0.0.1` only. NEVER deploy this to a public URL.**

Warehousd Phase 0 is a proof-of-concept implementation of a Postgres-backed query broker for LLM agents. The broker intercepts LLM-generated queries, re-validates them against a deny-by-default schema, and enforces Postgres role-based access control between dev and live data.

## Prerequisites

- **Node 22** or higher (see `.nvmrc`)
- **pnpm** (package manager)
- **Docker** and **Docker Compose** (for Postgres)

## Quick Start

1. **Prepare environment**
   ```bash
   cd poc
   pnpm install
   export ANTHROPIC_API_KEY="your-key-here"
   ```

2. **Start the stack**
   ```bash
   docker compose up
   ```
   This brings up:
   - Postgres (bound to `127.0.0.1:5432`)
   - The web app (http://127.0.0.1:3000)

   The broker CLI tools are available immediately; the web app initializes schema on first request.

3. **Visit the demo**
   - Open http://127.0.0.1:3000 in your browser
   - Use the three-pane chat interface to switch personas and test the grant workflow

## Test Instructions

Run the full Phase 0 acceptance subset:

```bash
pnpm test:up       # Spin up disposable test Postgres
pnpm test          # Run broker + CLI vitest suite
pnpm lint          # ESLint check
pnpm test:down     # Tear down test Postgres
```

Expected: all tests pass, lint clean.

## Demo Arc

The web app implements a three-person grant workflow to showcase broker capabilities:

1. **Priya (employee)** asks: *"What's the average salary for my team?"*
   - Broker intercepts the query, re-validates against schema
   - Priya has no `salary` grant → **access denied**
   - Chat shows the refusal reason

2. **Marcus (manager)** approves the grant
   - Approves via the chat interface (three-pane: persona switcher → grants UI → query result)
   - Grant is written to the `app_grants` table with `effective_at`

3. **Priya retries**
   - Same question
   - Broker re-validates, sees the new grant
   - Query re-executes → **salary average returned**

4. **Marcus revokes**
   - Revokes via the grants UI
   - Grant row updated with `revoked_at`

5. **Priya asks again**
   - **Access denied** (grant is inactive)

This flow demonstrates:
- Deny-by-default (Priya starts denied)
- Broker re-validation (grant change detected mid-session)
- Audit trail (all queries logged with grant status)
- Dual Postgres roles (dev/live isolation via role scopes)

## Component Status (Phase 0)

| Component | Status |
|---|---|
| Broker query/validation/audit | real |
| Field-level deny-by-default | real |
| Aggregation (avg/sum/count/min/max) | real |
| Dual dev/live Postgres roles | real |
| Synthetic generator (from schema only) | real |
| Named views | real |
| YAML loader + `apply` + `seed` (CLI) | real |
| Filter operators (eq/neq/gt/lt/gte/lte/like/in) | real |
| Persona switcher (auth) | **stubbed — POC-only, replaced by OAuth in MVP** |
| Better Auth / SSO / OAuth provider | absent (MVP) |
| MCP endpoint | absent (MVP — chat route mirrors the tools) |
| Admin UI | absent (MVP) |
| `warehousd start/stop/status/deploy` | absent (MVP — Phase 0 ships `apply`/`seed`) |
| SAML | absent |
| Connect-in-place | absent |
| Row-level / masking postures | absent (post-MVP) |

## Architecture

### Broker (packages/broker)

The query broker is the trust boundary:

- **Untrusted input**: LLM-generated SQL (or structured query) from the client
- **Trust function**: broker re-validates the request:
  1. Schema exists?
  2. Fields requested are in the grant (or schema default)?
  3. Filters are allowed operators?
  4. Aggregation is legal (granted fields only)?
- **Output**: executed result + audit row (INSERT-only)

The broker uses two Postgres role-scoped connection pools:
- `warehousd_dev_*`: queries against dev data
- `warehousd_live_*`: queries against live data

Clients cannot issue direct SQL; all queries flow through the broker.

### CLI (packages/cli)

- `apply <yaml>` — load schema/views/grants from YAML
- `seed <count>` — generate synthetic data (schema-only, via Postgres `gen_random_uuid()`)

### Web App (apps/web)

Next.js chat interface with:
- **Persona switcher** (Priya, Marcus, or Admin)
- **Query form** (natural language or structured)
- **Grants panel** (Marcus/Admin can grant/revoke)
- **Result display** and audit trail

All queries route through `/api/query` → broker → Postgres.

## Schema (YAML)

Phase 0 uses YAML to define:

```yaml
collections:
  employees:
    table: public.employees
    fields:
      id:
        type: uuid
        primary_key: true
      name:
        type: text
      salary:
        type: numeric
      dept:
        type: text

grants:
  priya:
    - collection: employees
      fields: [name, dept]       # salary is NOT granted by default
  marcus:
    - collection: employees
      fields: "*"                # managers see all fields
```

The broker loads this via `YAML.parse()` and enforces:
- **Deny-by-default**: fields not listed are forbidden
- **Validation order**: schema → grants → operators → result size
- **Two-tier**: dev grants can be different from live grants (via role scope)

## Network Trust Boundary

Phase 0 has **no network trust boundary**: Postgres, broker, and web app all run on `127.0.0.1`. Client→server HTTP is unencrypted.

**MVP will add:**
- TLS for client↔server
- OAuth for authentication
- Network isolation (private subnets, VPC)

## Threat Model

See [docs/threat-model.md](./docs/threat-model.md) for the Phase 0 trust model.
