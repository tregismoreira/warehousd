<p align="center">
  <img src=".github/assets/banner.svg" alt="warehousd" width="480">
</p>

<p align="center">
  <strong>An MCP-ready governed data layer for enterprises.</strong><br>
  All your documents and datasets in one place, safely queryable by AI assistants.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/warehousd"><img src="https://img.shields.io/npm/v/warehousd.svg" alt="npm version"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT-1D9E75" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-1A1A1A" alt="Node 22+">
  <img src="https://img.shields.io/badge/postgres-16-1A1A1A" alt="Postgres 16">
  <img src="https://img.shields.io/badge/MCP-streamable%20HTTP-1A1A1A" alt="MCP">
</p>

---

Connecting an LLM to real company data usually means handing it a database connection and hoping the prompt holds. warehousd replaces hope with enforcement: every request from an assistant is a **proposal** that a server-side broker re-validates against deny-by-default field postures and purpose-bound, expiring grants before a single row is read.

Access is tiered per person, not per assistant. Claude connected to warehousd reaches exactly what the user driving it has been granted — named fields, in named collections, for a stated purpose, until a stated expiry — and nothing else. Someone with no grant sees only that a collection exists. Revoke the grant and the very next query fails, no token refresh required.

One Docker container and one Postgres database. From `warehousd start` to "Claude is safely querying our data" in under 15 minutes.

<p align="center">
  <img src=".github/assets/concepts.svg" alt="A person asks a question in Claude; the MCP client proposes a query intent, never SQL; the broker re-validates it against that person's grant — collection, fields, filters, document and term scope — and builds the SQL itself from a named view, returning either granted fields or a refusal with a reason code and no data. Dev and live data live in separate schemas behind separate roles. Every decision is written to the audit log before the response is returned." width="820">
</p>

## Why

- **The model is untrusted.** MCP clients send structured query intents, never SQL. The broker builds SQL server-side from named views and a fixed operator whitelist.
- **Denied means absent.** Denied fields are never selected — they cannot appear in a response, an error message, or a log line.
- **Develop against synthetic data by default.** Promoting an app to real data is a flag flip by an admin: no code change, no new credentials.
- **Governance lives in git.** Collections and field postures are declared in `warehousd.yml` in your app's repo and applied idempotently.
- **Everything is audited.** Every broker decision — allowed or refused — is written before the response is returned.

## Quick start

Requires Docker and Node 22+.

```bash
mkdir acme-data && cd acme-data
npx warehousd init      # scaffolds warehousd.yml + .gitignore entries
npx warehousd start     # starts Postgres + server, applies config, seeds synthetic data
```

`start` prints the outputs contract and writes it to `.warehousd/outputs.json` — MCP and admin URLs, the database URL, a dev client id and secret, and the generated admin login, masked until `warehousd secrets --show`.

Then connect an assistant: in Claude, **Settings → Connectors → Add custom connector**, paste the MCP URL, and complete the OAuth flow. With SSO configured, that login step delegates to your IdP — connecting Claude is "log in with your company account," never a new password.

Walkthroughs: [connect-claude.md](docs/connect-claude.md) · [configure-sso.md](docs/configure-sso.md) · [CLI reference](docs/cli.md) · [configuration reference](docs/configuration.md)

## Configuration

`warehousd.yml` is the source of truth. `warehousd.local.yml` (gitignored) is deep-merged over it, and `${env:VAR}` interpolation keeps secrets out of YAML.

```yaml
project: acme
server: { port: 8722 }

taxonomies:
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

  people:
    description: Employee directory
    fields:
      id:            { type: uuid, posture: allow, pk: true }
      full_name:     { type: text, posture: allow }
      department_id: { type: uuid, posture: allow, fk: departments.id }
      email:         { type: text, posture: { read: mask, write: deny }, mask: { transform: domain } }
      home_address:  { type: text, posture: deny }   # can never be granted

  case_files:
    type: file                      # parsed + full-text indexed
    description: Client case files
    source: ./seed/case-files-dev   # dev content — never real corporate files
    source_live: ./seed/case-files-live
    taxonomies: [tags]
    fields:
      title:   { posture: allow }
      content: { posture: allow }
      path:    { posture: deny }    # gates documents, never readable
```

Postures are two-tier and have three axes. `posture: deny` means the field can *never* be granted without editing the file. `posture: allow` only makes a field **grantable** — it stays denied per user until a manager approves a grant covering it. A bare value governs *reading* and leaves writing denied; the long form `posture: { read: allow, write: allow }` opts a field into the write path. `read: mask` is the level in between: readable, but as a transform computed in SQL, so the raw value never leaves Postgres. Add `unmask: allow` and the raw value becomes grantable too — a manager ticks it per grant, and the audit row says who saw it.

Every key, including taxonomies, semantic search, ACLs and connect-in-place collections: [configuration.md](docs/configuration.md).

## Features

- **Collections and documents** — queryable datasets and file collections (`.md`/`.txt`/`.pdf`/`.docx` parsed into documents). Same postures, grants and audit for both. [glossary.md](docs/glossary.md)
- **Field-, document- and term-level grants** — `(user, collection, purpose, verbs, fields, environment, expiry)`, optionally narrowed to specific documents or taxonomy terms. Evaluated fresh on every request, so revocation is immediate — never baked into a token.
- **Per-document ACLs** — `acl: true` lets you restrict one document to `user:`/`group:` principals, enforced in the same `WHERE` every read uses, so a `count` returns what the caller may see. [configuration.md](docs/configuration.md#per-document-acls)
- **Expressive-but-safe queries** — filters, ordering, pagination, and aggregation (`avg`/`sum`/`count`/`min`/`max` with `groupBy`), permitted only over fields the caller could already read row by row.
- **Search** — full text, semantic (pgvector/HNSW) or hybrid RRF, always grant-filtered before ranking. [configuration.md](docs/configuration.md#semantic-search)
- **Taxonomies** — declare a vocabulary, bind it to collections, scope grants to terms. A grant limited to `hr` silently excludes `finance` documents; the user never learns they exist.
- **Write path** — append-only revisions; a `proposal_only` grant holds a write pending until a human approves it. [architecture.md](docs/architecture.md#proposals)
- **Identity you already have** — Better Auth handles sessions, OIDC and SAML SSO with JIT provisioning and group→role mapping, and makes warehousd an OAuth 2.1 authorization server for MCP clients. [configure-sso.md](docs/configure-sso.md)
- **Three role-scoped surfaces** — Admin (collections, SSO, users, clients, import, audit browser), Manager (grant inbox, approve with trimmed fields and expiry, revoke), Member (my grants, request access, how to connect).

## The security model

Seven invariants, each enforced structurally rather than by convention, and each covered by an acceptance test:

1. **Broker-only data path.** No code outside the broker library reads collection tables — enforced by Postgres role privileges, not discipline.
2. **Deny by default.** No posture means denied. No grant means the user sees nothing beyond a collection's name and description.
3. **The client is untrusted.** Query intents are re-validated server-side; no client-supplied SQL fragment ever reaches the database.
4. **Denied means absent**, not filtered — from responses, errors, and logs.
5. **Dev never touches real data.** Two Postgres roles with two connection pools; the token's env scope selects the pool. A schema-resolution bug cannot cross the wall because the database itself refuses.
6. **Env parity.** Dev and live run identical postures and grant logic; only the source schema differs.
7. **Everything is audited**, before the response is returned.

Environment is never a request parameter. It exists only as an OAuth scope (`env:dev` / `env:live`) in a signed, short-lived token, intersected server-side with the client's policy *and* the user's live-grant eligibility. A client without `env:live` can request it all day and will only ever receive `env:dev`.

The long version, including how each invariant is enforced and how to put a new adapter in front of the broker: [architecture.md](docs/architecture.md). Deployment expectations and what is deliberately out of scope: [SECURITY.md](SECURITY.md).

## Architecture

A modular monolith: one deployable, one database, one hard internal boundary. Adapters are thin and replaceable; the broker is a pure library with zero HTTP, MCP, or UI imports, and is independently testable.

<p align="center">
  <img src=".github/assets/architecture.svg" alt="Two host processes consume one broker library: the Next.js application, whose thin adapters are the MCP server, the REST API and the web UI; and the warehousd CLI, which applies config, runs migrations, seeds synthetic data and imports. The broker is a pure library with no HTTP, MCP, UI or LLM imports, turning identity, grants and a query intent into rows or a refusal, and auditing every decision before the response returns. The adapters inject what the broker must not contain: the providers package for embedding and file extraction, and the audit sink. Postgres holds the app schema alongside separate data_live and data_synth schemas." width="820">
</p>

The CLI is the second consumer, not a second data path: it reaches the same broker library for config apply, migrations, synthetic seeding and import, and never reads a collection table any other way.

```
apps/web/            Next.js — UI, MCP and REST adapters, auth routes (the Docker image)
packages/broker/     the core: grants, query validation, synthetic data, indexing, YAML loader
packages/providers/  optional heavy deps behind broker interfaces — embedder, PDF/DOCX, XLSX
packages/cli/        the published `warehousd` npm CLI
examples/harbor/     a complete consuming project (the demo company)
```

## MCP surface

One OAuth-protected endpoint at `/mcp`, streamable HTTP, nine tools:

| Tool | Behavior |
|---|---|
| `list_collections` | Names and descriptions only — no schema, no counts. |
| `describe_collection` | Only the fields visible under the caller's grants. |
| `query_collection` | Filters, ordering, limits, aggregation — re-validated, then executed. |
| `search_documents` | Ranked text, semantic or hybrid search over a file collection, grant-filtered. |
| `get_document` | A single document, reduced to the fields the grant allows. |
| `create_document` | Writes, or opens a proposal under a `proposal_only` grant. |
| `update_document` | As above, on an existing document. |
| `delete_document` | As above; a delete is a revision, never a physical removal. |
| `request_access` | Opens a pending grant request for a manager to approve. |

**There is deliberately no `approve` or `reject` tool.** The untrusted model may propose; only an authenticated human may approve. A write under a `proposal_only` grant returns `pending`, and pending content is invisible to everyone — including its own author — until a human approves it.

Refusals return reason codes (`no_grant`, `field_denied`, …) plus a request-access hint — never a denied value, never SQL.

## REST surface

The same broker and the same grants over `/v1`, for clients that are not MCP — collections, documents, revisions, ACLs, query, search, proposals and a change feed. Machine callers authenticate with an API key (`client_credentials`) or by exchanging an IdP-issued JWT at `POST /v1/token` (RFC 8693), so the acting user stays the subject of the grant check rather than a shared service account. Endpoints and status codes: [rest-api.md](docs/rest-api.md).

## CLI

| Command | Purpose |
|---|---|
| `init` | Scaffold `warehousd.yml` and `.gitignore` entries. `--from <dir>` infers a scaffold from spreadsheets. |
| `start` · `restart` · `stop` · `status` | Run the local stack and print the outputs contract. |
| `doctor` · `logs` · `open` · `secrets` | Pre-flight, container logs, browser, generated credentials. |
| `apply` | Re-apply YAML (collections, postures, views) without a restart. |
| `migrate plan\|generate\|status` | Reviewed DDL for changes `apply` will not make — type changes, renames, drops. |
| `import map\|validate\|run` | Real-data CSV/JSON/XLSX import, with a mapping proposal and a dry run. |
| `seed` · `index <collection>` · `embed [collection]` | Regenerate synthetic data, re-index files, fill embeddings. |
| `deploy` | Ship to Fly.io, Railway or a Compose file behind a production pre-flight. |

Every command takes `--json`, `-q/--quiet`, `--no-color` and `--verbose`. Progress goes to stderr and results to stdout, so `warehousd status --json | jq` works and `warehousd start 2>/dev/null` prints just the summary. Credentials are masked in the human output; `--json` does not mask them.

Bring your own Postgres by setting `database.url`. After the first image pull, `start` works with no network at all — synthetic generation uses wordlists, not a model.

Full reference, flags and the outputs contract: [cli.md](docs/cli.md) · [migrations.md](docs/migrations.md).

## Component status

Everything listed in this README is implemented. Two exceptions, both tracked in [docs/status.md](docs/status.md), which gives a per-component verdict checked against the code:

- **Multi-tenancy (`org_id`)** — *partial*. Every grant, audit event and document carries an org, isolated by a view predicate and RLS, but a single implicit org is created at bootstrap and nothing yet resolves a caller's org from their session or IdP claim.
- **SCIM and compliance exports** — *not built*.

## Contributing

Consumers never need this. To work on warehousd itself, [CONTRIBUTING.md](CONTRIBUTING.md) has the full setup — install, environment variables, bootstrap, and the six checks CI gates on (`lint`, `typecheck`, `format:check`, `test`, `build`, `e2e`). [docs/testing.md](docs/testing.md) covers the suites, including the slow ones.

[examples/harbor/README.md](examples/harbor/README.md) walks through the demo company on its own terms — seven personas, 20 collections, planted canary values. The shortest way to understand the product is to run it: [20 things to try](examples/harbor/SCENARIOS.md), in difficulty order, from "what does an ungranted user actually see" to the governed write path and dev/live isolation.

## Coding agents

[AGENTS.md](AGENTS.md) is the single source of instructions for the assistant *writing* the code — not for the ones querying data through it. It is deliberately vendor-neutral; `CLAUDE.md` only imports it. Two of its rules are scripts rather than prose (`pnpm agent:guard`, `pnpm agent:cleanup`), because `docker-compose.test.yml` binds a fixed host port and a second checkout of this repo shares the first one's Postgres — and its cores. Under Claude Code, `.claude/hooks/` runs both automatically.

## Documentation

**Running warehousd**

| | |
|---|---|
| [docs/cli.md](docs/cli.md) | Command reference, outputs contract, offline behavior |
| [docs/configuration.md](docs/configuration.md) | Every key in `warehousd.yml` |
| [docs/connect-claude.md](docs/connect-claude.md) | Adding the MCP connector end to end |
| [docs/configure-sso.md](docs/configure-sso.md) | Registering an OIDC or SAML IdP |
| [docs/rest-api.md](docs/rest-api.md) | `/v1` endpoints, auth flows, status codes |
| [docs/migrations.md](docs/migrations.md) | Schema changes `apply` will not make on its own |
| [docs/deploy-fly.md](docs/deploy-fly.md) · [railway](docs/deploy-railway.md) · [compose](docs/deploy-compose.md) | End-to-end deployment runbooks |
| [docs/deploy-database.md](docs/deploy-database.md) | Pointing a deployment at Supabase, Neon, Railway or your own Postgres |
| [examples/harbor/README.md](examples/harbor/README.md) | The demo project end to end — collections, personas, the grant arc |
| [examples/harbor/SCENARIOS.md](examples/harbor/SCENARIOS.md) | 20 things to try against the demo, simplest first |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability, deployment expectations, known limitations |

**Understanding and changing it**

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How it works and why — invariants, broker, env-as-scope, adapters |
| [docs/glossary.md](docs/glossary.md) | Collection, document, field — and the words we avoid |
| [docs/status.md](docs/status.md) | Per-component status, checked against the code |
| [docs/roadmap.md](docs/roadmap.md) | What is planned, and where the open-source line sits |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Local setup, ground rules, what to run before a pull request |
| [AGENTS.md](AGENTS.md) | Instructions for coding agents — conventions, test placement, machine load |
| [docs/testing.md](docs/testing.md) | The suites, what they assert, what is still manual |
| [docs/releasing.md](docs/releasing.md) | Cutting a tagged release of the image and the CLI |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release |

## Roadmap

Aggregate-only postures with inference-leak protection · org resolution at the auth boundary · streaming imports · audit retention and export · grant expiry notifications.

[docs/roadmap.md](docs/roadmap.md) has the detail, and states where the open-source line sits: everything shipped is MIT and stays MIT.

## License

[MIT](LICENSE).
