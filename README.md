<p align="center">
  <img src=".github/assets/banner.svg" alt="warehousd" width="380">
</p>

<p align="center">
  <strong>An MCP-ready governed data layer for enterprises.</strong><br>
  Your data, safely queryable by AI assistants.
</p>

<p align="center">
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT-1D9E75" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-1A1A1A" alt="Node 22+">
  <img src="https://img.shields.io/badge/postgres-16-1A1A1A" alt="Postgres 16">
  <img src="https://img.shields.io/badge/MCP-streamable%20HTTP-1A1A1A" alt="MCP">
</p>

---

Connecting an LLM to real company data usually means handing it a database
connection and hoping the prompt holds. warehousd replaces hope with
enforcement: every request from an assistant is a **proposal** that a
server-side broker re-validates against deny-by-default field postures and
purpose-bound, expiring grants before a single row is read.

Access is tiered per person, not per assistant. Claude connected to warehousd
reaches exactly what the user driving it has been granted — named fields, in
named collections, for a stated purpose, until a stated expiry — and nothing
else. Someone with no grant sees only that a collection exists. Revoke the
grant and the very next query fails, no token refresh required.

One Docker container and one Postgres database. From `warehousd start` to
"Claude is safely querying our data" in under 15 minutes.

<p align="center">
  <img src=".github/assets/concepts.svg" alt="A person asks a question in Claude; the MCP client proposes a query intent, never SQL; the broker re-validates it against that person's grant — collection, fields, filters, document and term scope — and builds the SQL itself from a named view, returning either granted fields or a refusal with a reason code and no data. Dev and live data live in separate schemas behind separate roles. Every decision is written to the audit log before the response is returned." width="820">
</p>

## Why

- **The model is untrusted.** MCP clients send structured query intents, never
  SQL. The broker builds SQL server-side from named views and a fixed operator
  whitelist.
- **Denied means absent.** Denied fields are never selected — they cannot
  appear in a response, an error message, or a log line.
- **Develop against synthetic data by default.** Apps are built and shipped
  against generated data; promoting one to real data is a single flag flip by
  an admin, with no code change and no new credentials.
- **Governance lives in git.** Collections and field postures are declared in
  `warehousd.yml` in your app's repo and applied idempotently.
- **Everything is audited.** Every broker decision — allowed or refused — is
  written before the response is returned.

## Quick start

Requires Docker and Node 22+.

```bash
mkdir acme-data && cd acme-data
npx warehousd init      # scaffolds warehousd.yml + .gitignore entries
npx warehousd start     # starts Postgres + server, applies config, seeds synthetic data
```

`start` prints the outputs contract and writes it to `.warehousd/outputs.json`:

```
MCP Server:   http://localhost:8722/mcp
Admin UI:     http://localhost:8722/admin
Environment:  dev
Dev Client:   ID: … / Secret: …
Admin Login:  admin@warehousd.local / <generated password>
```

Then connect an assistant: in Claude, **Settings → Connectors → Add custom
connector**, paste the `mcpUrl`, and complete the OAuth flow. With SSO
configured, that login step delegates to your IdP — connecting Claude is "log
in with your company account," never a new password.

Full walkthroughs: [connect-claude.md](docs/connect-claude.md) ·
[configure-sso.md](docs/configure-sso.md) · [CLI reference](docs/cli.md) ·
[configuration reference](docs/configuration.md)

## Configuration

`warehousd.yml` is the source of truth. `warehousd.local.yml` (gitignored) is
deep-merged over it, and `${env:VAR}` interpolation keeps secrets out of YAML.

```yaml
project: acme
server: { port: 8722 }

taxonomies:
  client:
    label: Client
    # dataset-sourced: terms are rows of `clients`, not literals in this file
    source: { collection: clients, slug: client_number, label: name }
  tags:
    label: Tags
    multiple: true
    terms:
      urgent: { label: Urgent }
      confidential: { label: Confidential }

collections:
  departments:
    description: Departments
    fields:
      id:   { type: uuid, posture: allow, pk: true }
      name: { type: text, posture: allow }

  clients:
    description: Client directory
    fields:
      id:            { type: uuid, posture: allow, pk: true }
      client_number: { type: text, posture: allow }
      name:          { type: text, posture: allow }

  people:
    description: Employee directory
    fields:
      id:              { type: uuid, posture: allow, pk: true }
      full_name:       { type: text, posture: allow }
      email:           { type: text, posture: allow }
      department_id:   { type: uuid, posture: allow, fk: departments.id }
      department_name: { type: text, posture: allow, view_join: { table: departments, column: name, on: department_id } }
      home_address:    { type: text, posture: deny }   # can never be granted

  case_files:
    type: file                      # parsed + full-text indexed
    description: Client case files
    source: ./seed/case-files-dev   # dev content — never real corporate files
    source_live: ./seed/case-files-live
    taxonomies: [client, tags]      # plural, list of vocabulary slugs
    fields:
      title:          { posture: allow }
      content:        { posture: allow }
      path:           { posture: deny }    # gates documents, never readable
      matter_number:  { type: text, posture: allow }
      filed_date:     { type: date, posture: allow }

synthetic:
  documents_per_collection: { people: 40 }
```

Postures are two-tier. `posture: deny` means the field can *never* be granted
without editing the file. `posture: allow` only makes a field **grantable** —
it stays denied per user until a manager approves a grant covering it.

Every key: [configuration.md](docs/configuration.md).

## Features

**Collections and documents** — Datasets (queryable tables) and file
collections (`.md`/`.txt` parsed into documents, indexed with Postgres
full-text search). Both flow through the same postures, grants, and audit.

**Field-level and document-level access control** — Grants are
`(user, collection, purpose, allowed fields, environment, expiry)`, optionally
narrowed to specific documents or taxonomy terms. Evaluated fresh on every
request, so revocation is immediate — never baked into a token.

**Expressive-but-safe queries** — Filters, ordering, pagination, and
aggregation (`avg`/`sum`/`count`/`min`/`max` with `groupBy`) — enough for the
assistant to answer real analytical questions, with aggregation permitted only
over fields the caller could already read row by row.

**Taxonomies** — Declare a vocabulary, bind it to collections, and scope
grants to terms. A grant limited to `hr` silently excludes `finance`
documents; the user never learns they exist.

**Identity you already have** — Better Auth handles sessions, OIDC and SAML
SSO with JIT provisioning, and makes warehousd an OAuth 2.1 authorization
server for MCP clients.

**Three role-scoped surfaces** — Admin (collections, SSO, users, clients,
import, audit browser), Manager (grant inbox, approve with trimmed fields and
expiry, revoke), Member (my grants, request access, how to connect).

## The security model

Seven invariants, each enforced structurally rather than by convention, and
each covered by an acceptance test:

1. **Broker-only data path.** No code outside the broker library reads
   collection tables — enforced by Postgres role privileges, not discipline.
2. **Deny by default.** No posture means denied. No grant means the user sees
   nothing beyond a collection's name and description.
3. **The client is untrusted.** Query intents are re-validated server-side; no
   client-supplied SQL fragment ever reaches the database.
4. **Denied means absent**, not filtered — from responses, errors, and logs.
5. **Dev never touches real data.** Two Postgres roles with two connection
   pools; the token's env scope selects the pool. A schema-resolution bug
   cannot cross the wall because the database itself refuses.
6. **Env parity.** Dev and live run identical postures and grant logic; only
   the source schema differs.
7. **Everything is audited**, before the response is returned.

Environment is never a request parameter. It exists only as an OAuth scope
(`env:dev` / `env:live`) in a signed, short-lived token, intersected
server-side with the client's policy *and* the user's live-grant eligibility.
A client without `env:live` can request it all day and will only ever receive
`env:dev`.

The long version, including how each invariant is enforced and how to put a new
adapter in front of the broker: [architecture.md](docs/architecture.md).

## Architecture

```
┌─────────────────────────────────────────────────┐
│ Next.js application                             │
│                                                 │
│  Adapters (thin, replaceable):                  │
│  ├── MCP server  (streamable HTTP, OAuth 2.1)   │
│  ├── Web UI      (admin / manager / member)     │
│  └── [future]    REST, CMS delivery, apps       │
│                    │                            │
│         ▼ all calls go through ▼                │
│  ┌───────────────────────────────────────────┐  │
│  │ BROKER (pure library, no HTTP/MCP deps)   │  │
│  │ (identity, grants, intent) → rows|refusal │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  Auth (Better Auth: sessions, SSO, OAuth)       │
└─────────────────────────────────────────────────┘
                     │
        Postgres (single instance)
        ├── app        (users, grants, postures, audit)
        ├── data_live  (real data)
        └── data_synth (synthetic data)
```

A modular monolith: one deployable, one database, one hard internal boundary.
Adapters are thin and replaceable; the broker is a pure library with zero HTTP,
MCP, or UI imports, and is independently testable.

```
apps/web/          Next.js — UI, MCP adapter, auth routes (published as the Docker image)
packages/broker/   the core: grants, query validation, synthetic data, indexing, YAML loader
packages/cli/      the published `warehousd` npm CLI
examples/harbor/   a complete consuming project (the demo company)
```

## MCP surface

One OAuth-protected endpoint at `/mcp`, streamable HTTP, five tools:

| Tool | Behavior |
|---|---|
| `list_collections` | Names and descriptions only — no schema, no counts. |
| `describe_collection` | Only the fields visible under the caller's grants. |
| `query_collection` | Filters, ordering, limits, aggregation — re-validated, then executed. |
| `search_documents` | Ranked full-text search over a file collection, grant-filtered. |
| `request_access` | Opens a pending grant request for a manager to approve. |

Refusals return reason codes (`no_grant`, `field_denied`, …) plus a
request-access hint — never a denied value, never SQL.

## CLI

| Command | Purpose |
|---|---|
| `warehousd init` | Scaffold `warehousd.yml` and `.gitignore` entries. |
| `warehousd start` | Start server + Postgres, apply config, seed, print outputs. |
| `warehousd stop [--destroy --yes]` | Stop containers; optionally drop the volume. |
| `warehousd status` | Health and the outputs block. |
| `warehousd apply` | Re-apply YAML (collections, postures, views) without a restart. |
| `warehousd seed` / `regen-synth` | Generate or regenerate synthetic data. |
| `warehousd index <collection>` | Re-index a file collection. |

Bring your own Postgres by setting `database.url`. After the first image pull,
`start` works with no network at all — synthetic generation uses wordlists, not
a model.

## Component status

Per component, what is fully implemented versus deliberately narrowed or not
yet built:

| Component | Status | Notes |
|---|---|---|
| Broker enforcement — postures, grants, field/document/term scoping | **real** | |
| Filter operators, ordering, pagination | **real** | Server-built SQL from named views; fixed operator whitelist. |
| Aggregation (`avg`/`sum`/`count`/`min`/`max` + `groupBy`) | **real** | Only over fields the caller can already read row by row. |
| Dev/live isolation | **real** | Two Postgres roles, two pools, selected by token scope. |
| Synthetic data generation | **real** | From the schema only; deterministic by seed; FK-consistent. |
| File collections + full-text search | **real** | `.md`/`.txt`; `tsvector` + GIN, `ts_rank_cd` ordering. |
| Taxonomies and term-scoped grants | **real** | |
| OAuth 2.1 provider, env-as-scope, dynamic client registration | **real** | 15-min access tokens; scope rules re-run on refresh. |
| MCP endpoint (streamable HTTP) | **real** | |
| SSO — OIDC and SAML | **real** | Better Auth SSO plugin; automated OIDC and SAML round trips against Keycloak. Connecting a hosted IdP is a [documented manual runbook](docs/configure-sso.md). |
| Admin / manager / member web UI | **real** | |
| Audit log | **real** | Insert-only for the app role. |
| Real-data import | *simplified* | Admin-only CSV/JSON append into `data_live` through an `INSERT`-only role. No update or delete path. |
| App-schema migrations | *simplified* | Create-if-not-exists; versioned migrations are planned. |
| Semantic / vector search | *stubbed* | `vector(1536)` column and pgvector are reserved but not populated. |
| `warehousd deploy` | *not built* | Planned; deploy by running the published image yourself for now. |
| Write path through MCP | *not built* | Read and access-request only, by design. |
| Masking / transform postures | *not built* | Fields are allow or deny — nothing in between. |
| Connect-in-place to external databases | *not built* | Collections live in warehousd's Postgres. |
| PDF/DOCX extraction, upload UI | *not built* | Indexing reads local directories. |
| Multi-tenancy, SCIM, compliance exports, IdP group→role mapping | *not built* | One deployment = one organization; JIT provisioning creates a `member`. |

## Contributing

Consumers never need this — but if you want to work on warehousd itself:

```bash
pnpm install
pnpm test:up                                             # Postgres 16 + pgvector on :54330
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/harbor pnpm test # unit + integration
pnpm lint
pnpm build                                               # production build + typecheck
pnpm e2e                                                 # Playwright, real browser
pnpm test:down
```

[CONTRIBUTING.md](CONTRIBUTING.md) has the full setup, including running the app
against the Harbor Law demo company — seven personas, nineteen collections, planted
canary values, and a pre-seeded grant request. Demo mode seeds personnel including
`ana@demo.local` (admin), `marcus@demo.local` (manager), and `mia@demo.local` (member),
password `demo`.

The demo arc is the shortest way to understand the product: search case files
as Mia and watch the probe refuse, have Marcus approve a trimmed grant, search
again and see results, then revoke and watch the next query fail — with every
decision visible in the audit browser.

## Documentation

**Running warehousd**

| | |
|---|---|
| [docs/cli.md](docs/cli.md) | Command reference, outputs contract, offline behavior |
| [docs/configuration.md](docs/configuration.md) | Every key in `warehousd.yml` |
| [docs/connect-claude.md](docs/connect-claude.md) | Adding the MCP connector end to end |
| [docs/configure-sso.md](docs/configure-sso.md) | Registering an OIDC or SAML IdP |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability, deployment expectations, known limitations |

**Understanding and changing it**

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How it works and why — invariants, broker, env-as-scope, adapters |
| [docs/glossary.md](docs/glossary.md) | Collection, document, field — and the words we avoid |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Local setup, ground rules, what to run before a pull request |
| [docs/testing.md](docs/testing.md) | The suites, what they assert, what is still manual |
| [docs/releasing.md](docs/releasing.md) | Cutting a tagged release of the image and the CLI |

## Roadmap

Semantic search over the reserved embedding column · document upload with
PDF/DOCX extraction · a governed write path (`broker.mutate`) ·
connect-in-place collections over external Postgres · masking postures ·
aggregate-only postures with inference-leak protection · deploy targets ·
IdP group→role mapping.

## License

[MIT](LICENSE).
