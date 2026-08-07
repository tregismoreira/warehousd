# Harbor Law — the warehousd example project

Harbor Law is a fictional mid-size law firm. This directory is a complete
warehousd project for it: 20 collections, three vocabularies, 16 fields that are
denied outright, 18 seed documents in the dev environment (five more in live),
and about 4,400 synthetic documents generated deterministically from the schema.

It exists so the interesting questions have an answer you can run:

- What does a person with **no grant** actually see? (That a collection exists.
  Nothing in it.)
- What happens to a denied field when someone asks for it by name? (It is not
  selected, so it appears in no response, no error, and no log line.)
- What does the request → approve → query loop look like end to end?
- What does an assistant reach once it is connected through OAuth?

Everything here is synthetic. No real client, matter, or person is represented.

## Run it

Requires **Docker** and **Node 22.12+**. Nothing else — the CLI pulls its own
server and Postgres images.

```bash
git clone https://github.com/tregismoreira/warehousd.git
cd warehousd/examples/harbor
npx warehousd start
```

Or install the CLI once and use it as a command from the same directory:

```bash
npm install -g warehousd
warehousd start
```

If you want the example without the rest of the repository:

```bash
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/tregismoreira/warehousd.git
cd warehousd
git sparse-checkout set examples/harbor
cd examples/harbor
npx warehousd start
```

`start` is idempotent — re-run it after editing `warehousd.yml` and it picks the
changes up. It takes a few minutes the first time, most of it pulling images.

### What `start` does here

It starts a Postgres container and the server container, applies
`warehousd.yml` (schemas, collections, `v_<collection>` views), generates the
synthetic documents at seed `42`, indexes the three file collections into the
dev environment, seeds the demo personas, and prints the outputs contract:

```
═══════════════════════════════════════════════════════════
warehousd is running
═══════════════════════════════════════════════════════════

MCP Server:   http://localhost:8722/mcp
API Server:   http://localhost:8722
Admin UI:     http://localhost:8722/admin
Database:     postgres://warehousd:PASSWORD@localhost:8723/warehousd
Environment:  dev
Dev Client:   ID: <oauth-client-id> / Secret: <oauth-client-secret>
Admin Login:  admin@warehousd.local / <generated password>
═══════════════════════════════════════════════════════════
```

The same block lands in `.warehousd/outputs.json`, and `warehousd status`
reprints it. Generated secrets live in `.warehousd/state.json` — both files are
gitignored, and both are local to this directory.

Harbor pins `server: { port: 8722 }`, so the app is on **8722** and its database
on **8723** (`port + 1`). Free them first, or change the port in the config.

```bash
warehousd stop                 # containers down, data kept
warehousd stop --destroy --yes # also drops the volume — irreversible
```

## Sign in

`demo: true` in `warehousd.yml` seeds seven personas. Password for all of them
is `demo`.

| Persona | Role | Grants at first boot |
|---|---|---|
| `ana@demo.local` | admin | Every collection, dev environment |
| `marcus@demo.local` | manager | Every collection, dev environment |
| `mia@demo.local` | member | **None** |
| `priya@demo.local` | manager | None |
| `dan@demo.local` | member | None |
| `elena@demo.local` | member | None |
| `omar@demo.local` | member | None |

There is also `admin@warehousd.local`, whose password `start` generates and
prints. Use it if you would rather not sign in as a persona.

Mia starting with nothing is the point, not an oversight — it is what makes the
grant flow demonstrable on a fresh install.

### The arc worth walking

1. Sign in as **Mia**. Every collection is listed; none of them return
   documents. That asymmetry is deliberate: existence is not a secret, content
   is.
2. Request access to `matters` — named fields, a purpose, an expiry.
3. Sign out, sign in as **Marcus**, approve it.
4. Back as Mia, the same query now returns the granted fields, and only those.
   `matters.privileged_notes` is `posture: deny`, so it was never on the table
   to grant.
5. Revoke the grant as Marcus. Mia's next query refuses — grants load fresh per
   request, so there is no token to wait out.
6. Open the audit log as Ana. Every step above is a row, refusals included.

**[SCENARIOS.md](SCENARIOS.md) takes that from six steps to twenty**, in
difficulty order — term-scoped grants, per-document ACLs, masking and unmasking,
aggregation and its ceiling, MCP and REST, the governed write path, dev/live
isolation, and the operator's loop. Each one names the observable fact that makes
the claim true rather than asserted.

## What is in the config

`warehousd.yml` is the whole of it — one file, reviewed in git, and the only
place governance is declared.

**17 dataset collections**, generated from their schema:
`departments`, `people`, `salaries`, `announcements`, `metrics`, `clients`,
`matters`, `time_entries`, `invoices`, `trust_accounts`, `expenses`, `vendors`,
`conflict_checks`, `court_deadlines`, `performance_reviews`, `pto_requests`,
`matter_tasks`.

**Three file collections**, indexed from Markdown with a `tsvector` and searched
by term: `policies`, `case_files`, `precedents`.

**16 denied fields**, spread on purpose across collections nobody would
think to lock down as a whole — among them `people.home_address`,
`people.bar_number`, `salaries.ssn`, `matters.privileged_notes`,
`clients.billing_address`, `trust_accounts.account_number`,
`conflict_checks.notes`, `performance_reviews.improvement_plan`,
`pto_requests.reason`, and the `path` of every file collection. A denied field
cannot be granted by anyone, including an admin.

**Three vocabularies.** `department` and `tags` are literal term lists;
`client` is dataset-sourced — its terms are rows of the `clients` collection,
resolved by `client_number`. Documents bind to them in their frontmatter:

```markdown
---
owner: Priya Raghavan
client: c-0042
tags: [litigation, discovery, motion]
matter_number: M-2025-0184
document_type: motion
confidentiality: internal
filed_date: 2025-03-14
---
```

That is what makes term-scoped grants demonstrable: "Mia may search
`case_files`, but only documents for client `c-0042`, tagged `discovery`."

**One writable collection.** `matter_tasks` is `writable: true` with three
write-allowed fields, and is the target of the governed write path — an
assistant proposes a task, and a `proposal_only` grant holds it pending until a
human approves it. It has no foreign key, so a proposal does not have to resolve
a matter first.

**One collection with per-document ACLs.** `announcements` is `acl: true`, so an
individual announcement can be taken out of a grant that otherwise covers the
whole collection. Restrict one in **Admin → Collections → announcements →
Access** and every read narrows at once: it stops appearing in queries and
searches, `get_document` answers `not_found`, and a `count` over the collection
comes back one lower — not a total with a gap, which would itself report how
many documents you cannot see. Removing every principal makes it public again.
A document with no ACL, which is all forty of them to begin with, is readable by
anyone the grant covers.

**Synthetic volume** is set per collection under `synthetic:` — 1,200 time
entries, 320 matters, 150 clients, 730 days of metrics, and so on. The client
count is load-bearing rather than decorative: `clients.client_number` generates
the dense sequence `C-0001…C-0150`, and the seed case files reference those
slugs directly, so cutting the number below 150 orphans document references.

## Connect an assistant

Take `mcpUrl` from the outputs block — `http://localhost:8722/mcp`. In Claude:
**Settings → Connectors → Add custom connector**, paste it, and complete the
OAuth flow. What you reach afterwards is exactly what the persona you logged in
as has been granted, which is the property worth testing here: connect as Mia
before her grant and again after.

The full walkthrough, including what to check at each hop, is in
[docs/connect-claude.md](../../docs/connect-claude.md).

## Dev and live

Harbor ships both environments wired but only one populated.

The dev environment holds the synthetic documents and the `seed/*-dev`
directories, and is what every seeded grant points at. The live environment has
its schema, its own Postgres role, and its own `seed/*-live` documents — but no
dataset rows, because nothing generates into live by design. Real rows arrive
only through an admin's CSV/JSON import.

To index the live documents:

```bash
warehousd index case_files --env live
```

Querying them still needs a live-scoped grant. The isolation is by role and by
schema, not by convention — a dev token cannot reach live data whatever it asks
for.

`seed/live.ts` is not part of this path. It belongs to the repository's own dev
bootstrap and imports test fixtures, so it neither runs nor is needed under the
published CLI.

## Poking at it

```bash
warehousd status                        # health + the outputs block
warehousd apply                         # re-apply YAML without a restart
warehousd seed --seed 7                 # different data, same shape
warehousd index policies                # re-index after editing seed/docs-dev
warehousd start --verbose               # log every Docker command
```

Same seed, same documents — `--seed 42` is the default and reproduces exactly
what a fresh `start` produced.

Full flags: [docs/cli.md](../../docs/cli.md). Config reference:
[docs/configuration.md](../../docs/configuration.md).

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

This example doubles as the fixture the repository's own test suites run
against, which is why it lives here rather than in a separate repo. Contributors
point the app at it with `WAREHOUSD_PROJECT_DIR=examples/harbor` and run it from
source instead of from a container — see
[CONTRIBUTING.md](../../CONTRIBUTING.md). Changing the collections, the field
postures or the synthetic volume in this file will move tests; expect to update
them in the same pull request.
