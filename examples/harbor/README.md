# Harbor Law — the warehousd example project

Harbor Law is a fictional mid-size law firm, and this directory is a complete warehousd project for it: 20 collections, three vocabularies, 16 denied fields, 18 seed documents in dev (five more in live), and about 4,400 synthetic documents generated deterministically from the schema.

It exists so the interesting questions have an answer you can run: what a person with no grant actually sees, what happens to a denied field when someone asks for it by name, what the request → approve → query loop looks like end to end, and what an assistant reaches once it is connected over OAuth.

Everything here is synthetic. No real client, matter or person is represented.

## Run it

Requires **Docker** and **Node 22.12+** — the CLI pulls its own server and Postgres images.

```bash
git clone https://github.com/tregismoreira/warehousd.git
cd warehousd/examples/harbor
npx warehousd start
```

Want the example without the rest of the repository:

```bash
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/tregismoreira/warehousd.git
cd warehousd
git sparse-checkout set examples/harbor
cd examples/harbor
npx warehousd start
```

`start` applies `warehousd.yml` (schemas, collections, `v_<collection>` views), generates the synthetic documents at seed `42`, indexes the three file collections into dev, seeds the demo personas, and prints the outputs contract:

```
MCP Server:   http://localhost:8722/mcp
API Server:   http://localhost:8722
Admin UI:     http://localhost:8722/admin
Database:     postgres://warehousd:PASSWORD@localhost:8723/warehousd
Environment:  dev
Dev Client:   ID: <oauth-client-id> / Secret: <oauth-client-secret>
Admin Login:  admin@warehousd.local / <generated password>
```

It is idempotent — re-run it after editing `warehousd.yml`. The same block lands in `.warehousd/outputs.json`, `warehousd status` reprints it, and generated secrets live in `.warehousd/state.json`; both files are gitignored and local to this directory.

Harbor pins `server: { port: 8722 }`, so the app is on **8722** and its database on **8723**. Free them first, or change the port in the config.

```bash
warehousd stop                 # containers down, data kept
warehousd stop --destroy --yes # also drops the volume — irreversible
```

## Sign in

`demo: true` seeds seven personas. Password for all of them is `demo`.

| Persona | Role | Grants at first boot |
|---|---|---|
| `ana@demo.local` | admin | Every collection, dev |
| `marcus@demo.local` | manager | Every collection, dev |
| `mia@demo.local` | member | **None** |
| `lanna@demo.local` | manager | None |
| `dan@demo.local` · `elena@demo.local` · `omar@demo.local` | member | None |

There is also `admin@warehousd.local`, whose password `start` generates and prints. Mia starting with nothing is what makes the grant flow demonstrable on a fresh install.

### The arc worth walking

1. Sign in as **Mia**. Every collection is listed; none return documents. Existence is not a secret, content is.
2. Request access to `matters` — named fields, a purpose, an expiry.
3. As **Marcus**, approve it.
4. Back as Mia, the same query returns the granted fields and only those. `matters.privileged_notes` is `posture: deny`, so it was never on the table.
5. Revoke as Marcus. Mia's next query refuses — grants load fresh per request, so there is no token to wait out.
6. Open the audit log as Ana. Every step above is a row, refusals included.

**[SCENARIOS.md](SCENARIOS.md) takes that from six steps to twenty** — term-scoped grants, per-document ACLs, masking and unmasking, aggregation and its ceiling, MCP and REST, the governed write path, dev/live isolation, and the operator's loop.

## What is in the config

`warehousd.yml` is the whole of it — one file, reviewed in git, and the only place governance is declared.

**17 dataset collections**, generated from their schema: `departments`, `people`, `salaries`, `announcements`, `metrics`, `clients`, `matters`, `time_entries`, `invoices`, `trust_accounts`, `expenses`, `vendors`, `conflict_checks`, `court_deadlines`, `performance_reviews`, `pto_requests`, `matter_tasks`.

**Three file collections**, indexed from Markdown with a `tsvector`: `policies`, `case_files`, `precedents`.

**16 denied fields**, spread across collections nobody would think to lock down as a whole — among them `people.home_address`, `people.bar_number`, `salaries.ssn`, `matters.privileged_notes`, `clients.billing_address`, `trust_accounts.account_number`, `conflict_checks.notes`, `performance_reviews.improvement_plan`, `pto_requests.reason`, and the `path` of every file collection. A denied field cannot be granted by anyone, admin included.

**Three vocabularies.** `department` and `tags` are literal term lists; `client` is dataset-sourced — its terms are rows of the `clients` collection, resolved by `client_number`. Documents bind to them in frontmatter:

```markdown
---
owner: Lanna Raghavan
client: c-0042
tags: [litigation, discovery, motion]
matter_number: M-2025-0184
document_type: motion
confidentiality: internal
filed_date: 2025-03-14
---
```

That is what makes a term-scoped grant demonstrable: "Mia may search `case_files`, but only documents for client `c-0042`, tagged `discovery`."

**One writable collection.** `matter_tasks` is `writable: true` with three write-allowed fields, and is the target of the governed write path. It has no foreign key, so a proposal does not have to resolve a matter first.

**One collection with per-document ACLs.** `announcements` is `acl: true`, so an individual announcement can be taken out of a grant that otherwise covers the whole collection. Restrict one in **Admin → Collections → announcements → Access** and every read narrows at once: it stops appearing in queries and searches, `get_document` answers `not_found`, and a `count` comes back one lower — not a total with a gap, which would itself report how many documents you cannot see.

**Synthetic volume** is per collection under `synthetic:` — 1,200 time entries, 320 matters, 150 clients, 730 days of metrics. The client count is load-bearing: `clients.client_number` generates the dense sequence `C-0001…C-0150` and the seed case files reference those slugs, so cutting it below 150 orphans document references.

## Connect an assistant

Take `mcpUrl` from the outputs block — `http://localhost:8722/mcp`. In Claude: **Settings → Connectors → Add custom connector**, paste it, complete the OAuth flow. What you reach afterwards is exactly what the persona you logged in as has been granted, which is the property worth testing: connect as Mia before her grant and again after.

Full walkthrough: [docs/connect-claude.md](../../docs/connect-claude.md).

## Dev and live

Harbor ships both environments wired but only dev populated. Live has its schema, its own Postgres role and its own `seed/*-live` documents, but no dataset rows — nothing generates into live by design, and real rows arrive only through an admin's CSV/JSON import.

```bash
warehousd index case_files --env live
```

Querying those still needs a live-scoped grant. The isolation is by role and by schema, not by convention: a dev token cannot reach live data whatever it asks for.

`seed/live.ts` is not part of this path — it belongs to the repository's own dev bootstrap and neither runs nor is needed under the published CLI.

## Poking at it

```bash
warehousd status                        # health + the outputs block
warehousd apply                         # re-apply YAML without a restart
warehousd seed --seed 7                 # different data, same shape
warehousd index policies                # re-index after editing seed/docs-dev
warehousd start --verbose               # log every Docker command
```

Same seed, same documents — `42` is the default and reproduces exactly what a fresh `start` produced. Full flags: [docs/cli.md](../../docs/cli.md). Config reference: [docs/configuration.md](../../docs/configuration.md).

## Files

| Path | |
|---|---|
| `warehousd.yml` | Collections, field postures, vocabularies, synthetic volume |
| `seed/docs-dev/` · `seed/docs-live/` | `policies` source documents |
| `seed/case-files-dev/` · `seed/case-files-live/` | `case_files` source documents |
| `seed/precedents-dev/` · `seed/precedents-live/` | `precedents` source documents |
| `seed/live.ts` | Repository dev-bootstrap only — not used by the CLI |
| `.warehousd/` | Generated state and outputs. Gitignored, local to this directory |

## Working on warehousd itself

This example doubles as the fixture the repository's own test suites run against, which is why it lives here rather than in a separate repo. Contributors point the app at it with `WAREHOUSD_PROJECT_DIR=examples/harbor` and run from source — see [CONTRIBUTING.md](../../CONTRIBUTING.md). Changing the collections, the field postures or the synthetic volume will move tests; expect to update them in the same pull request.
