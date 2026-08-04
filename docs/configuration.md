# Configuration reference

`warehousd.yml` is the source of truth. It lives at the root of the project that
*uses* warehousd — not inside warehousd's own repo — so governance is reviewed
and versioned in the same pull requests as the app it governs.

`warehousd init` scaffolds it; `warehousd start` and `warehousd apply` apply it
idempotently.

## File resolution

| File | Role |
|---|---|
| `warehousd.yml` | Committed. The source of truth. |
| `warehousd.local.yml` | Optional, gitignored. Deep-merged over the base — personal ports, smaller document counts, a real connection string. |

`${env:VAR_NAME}` anywhere in either file is replaced with that environment
variable, so secrets never live in YAML. An unresolved reference is a hard error
at load. Variable names must match `[A-Z0-9_]+`. References inside YAML comments
are left alone.

Config is **trusted input** — whoever can write these files already decides what
is grantable.

## Top level

```yaml
project: acme          # required. Namespace for containers, volumes, and state
demo: false            # default false. true seeds the three demo personas
server:
  port: 8722           # default 8722
  image: ...           # optional. Override the published server image
database:
  managed: true        # default: the CLI runs Postgres in Docker
  url: ${env:DATABASE_URL}   # alternative: bring your own Postgres
  port: 5432           # host port for the managed Postgres (default: server.port + 1)
deploy:
  target: fly          # only supported value
  app_name: harbor-warehousd   # ^[a-z0-9][a-z0-9-]{0,62}$, globally unique on Fly
  region: gru          # 3-letter Fly region code
  image: warehousd:local   # optional — override the published base image
  database:
    managed: true      # provision Fly Postgres, OR:
    # url: ${env:PROD_DATABASE_URL}   # attach a Postgres you already run
taxonomies: {}         # see below
collections: {}        # required
synthetic:
  documents_per_collection: {}
```

Setting `database.url` skips the managed Postgres container entirely. The server
still runs as a container, and `warehousd stop --destroy` will not touch a
database it does not manage.

`demo: true` seeds `ana@demo.local` (admin), `marcus@demo.local` (manager), and
`mia@demo.local` (member), all with the password `demo`, and shows them on the
login page. **Never enable it on a deployment reachable by anyone else.**

The `deploy:` block is optional and required only by `warehousd deploy`. It
names the target (`fly` is the only value), the globally unique app name, the
Fly region, and — most critically — **exactly one** of `managed: true` or a
`database.url`. An `image:` override is optional; if unset, the published image
is used. See [deploy-fly.md](deploy-fly.md) for the full deployment runbook.

## Collections

```yaml
collections:
  people:
    description: Employee directory        # required — this is what `list_collections` returns
    type: dataset                          # dataset (default) | file
    taxonomies: [department]               # optional — bind one or more vocabularies
    fields:
      id:              { type: uuid, posture: allow, pk: true }
      full_name:       { type: text, posture: allow }
      email:           { type: text, posture: allow }
      department_id:   { type: uuid, posture: allow, fk: departments.id }
      department_name: { type: text, posture: allow, view_join: { table: departments, column: name, on: department_id } }
      home_address:    { type: text, posture: deny }
```

Collection and field names must both match `[a-z_][a-z0-9_]*` (case-insensitive),
and a collection name may not contain `__` — that is reserved for file-collection
storage tables. Anything else is rejected at config load rather than reaching DDL.

### Field options

| Key | Meaning |
|---|---|
| `posture` | **Required.** `allow` / `deny`, or `{ read: …, write: … }`. |
| `type` | Required on dataset collections: `uuid`, `text`, `numeric`, `int`, `timestamptz`, `date`, `boolean`, `json`. Inferred for file collections. |
| `pk` | Marks the primary key. On a `writable` dataset this is *document* identity, not row identity. |
| `fk` | `collection.field` — honored by the synthetic generator so references resolve. |
| `view_join` | `{ table, column, on }` — pre-joined into `v_<collection>` so the queryable surface stays flat. Always write-deny. See below. |
| `nullable` | Lets the generator produce nulls, and makes the column optional on import. Not a database constraint — every column is nullable in Postgres either way (see below). |
| `min` / `max` | Range for generated numerics. |
| `gen` | Names a synthetic generator for this field, overriding the field-name heuristics. See below. |
| `searchable` | Dataset text fields only. Generates a `<field>_tsv` column and GIN index so `search_documents` reaches this collection. |

#### `nullable`

`nullable` governs two things and only two: whether the synthetic generator emits
the occasional NULL, and whether import treats a missing value as
`missing_required`. It never becomes a `not null` constraint — every column on a
dataset collection is nullable in Postgres, `nullable: true` or not.

It cannot become one. Cyclic and self-referential foreign keys are inserted NULL
and back-filled in a second pass, so `people.department_id` is genuinely NULL
between the two — a `not null` column would make the generator impossible to run.

Read the flag as "this field is optional in the data I expect", not as a
guarantee the database enforces.

#### `view_join`

```yaml
responsible_attorney_id:   { type: uuid, posture: allow, fk: people.id }
responsible_attorney_name: { type: text, posture: allow,
                             view_join: { table: people, column: full_name, on: responsible_attorney_id } }
```

`on` must name a sibling field declared `fk: <table>.id` pointing at the same
table; all three conditions are checked at config load. Each join gets its own
alias (`j_<field_name>`), so one collection may join the same table several
times — two attorneys on a matter, or `people.manager_id` back to `people`.

The column is derived, so it exists only on the view: it is never stored, and an
import naming it is rejected as a `derived_column`.

#### `gen`

Field-name heuristics cover the generic cases (`*_email`, `*_name`, `*_address`).
`gen` is for the ones they cannot tell apart — `matter_number`, `bar_number`,
`client_number` and `invoice_number` are all `*number*`:

```yaml
client_number: { type: text, posture: allow, gen: client_number }
```

Available: `client_number`, `matter_number`, `invoice_number`, `bar_number`
(dense deterministic sequences derived from the row index — `C-0001`, `C-0002`, …),
`company_name`, `industry`, `court_name`, `narrative`, `hourly_rate`.

The sequence hints are dense and stable for a given row count, which is what lets
committed seed documents reference a generated row by slug. Shrinking a
collection's row count below a slug a document names breaks indexing loudly.

### Postures are two-tier, on three axes

A posture governs reading, writing, and unmasking separately:

```yaml
email:       { type: text,    posture: allow }                        # read allow, write deny
base_salary: { type: numeric, posture: { read: deny, write: allow } }
```

- `deny` on an axis — the field can **never** be granted for it. It cannot be
  requested, cannot be approved, and is never selected. Changing that requires
  editing this file.
- `allow` on an axis — the field is *grantable* for it. It is still denied for
  every user until a manager approves a grant covering it.
- A field with no posture is denied on every axis.
- **A bare `allow` or `deny` sets the read axis and leaves write denied.** That
  is what keeps every configuration written before the write path existed valid,
  and stops any field becoming writable by accident.
- `view_join` fields are always write-deny. Asking for `write: allow` on one is a
  config error, not a silent override.

Denied fields are still useful: a denied `path` on a file collection can gate
which documents a grant reaches without ever being readable.

### Masking

`read: mask` is the third setting on the read axis. The field is grantable, and
what a grant gets back is a **transformed** value rather than the stored one:

```yaml
bank_account:
  type: text
  posture: { read: mask, write: deny }
  mask: { transform: last4 }            # ••••4321

pay_band:
  type: numeric
  posture: { read: mask, write: deny, unmask: allow }
  mask: { transform: bucket, width: 25000 }
```

The transform is computed **in SQL**, so the raw value is never fetched — it
cannot appear in a response, an error body or a log line, which is the same
standard `deny` sets. Masking applied after the rows came back would fail all
four and look identical in a passing test.

`unmask: allow` is the second tier, and it works exactly like `read: allow`: it
makes the raw value **grantable**, not readable. A manager still has to tick it
per grant, and the audit row records which fields a decision returned unmasked.
Omit it and nobody sees the raw value without editing this file.

| transform | types | result |
| --- | --- | --- |
| `redact` | any | `[redacted]` |
| `last4` | text | `••••4321` |
| `first: { chars: N }` | text | the first N characters, then `…` |
| `hash` | any | a keyed HMAC — equal values hash equal, so rows still group |
| `bucket: { width: N }` | numeric, int | quantised down to the band below |
| `year` | date, timestamptz | the year alone |
| `domain` | text | whatever follows the `@` |

`hash` needs `WAREHOUSD_MASK_KEY`. There is deliberately no default: a default
key is a public key, and the point of `hash` is a pseudonym only this deployment
can correlate.

**A masked field can be projected and nothing else.** It cannot appear in
`filters`, `orderBy`, `groupBy` or `aggregate` — those refuse with
`field_denied`. This is not a limitation to work around; it is what makes the
mask real. A banded salary you can still compare against falls to bisection in
about ten queries, `like` walks a redacted string one character at a time, and
`min`/`max` return the raw extremes outright.

A grant's own `document_filter` is the deliberate exception and may still
reference a masked column — it is written by a human manager rather than by the
model, the same reason a denied `path` can gate documents.

Refused at config load, because each one is a way for a mask to look applied and
not be: masking a `pk` (identity has to round-trip), masking a `searchable: true`
field (the generated `<field>_tsv` column indexes the raw value), masking a file
collection's `content` or `path`, a transform its column type cannot compute, and
`unmask: allow` on a field that is not masked.

### Writable collections

```yaml
collections:
  pages:
    description: Authored knowledge
    writable: true            # opt in; default false
    fields:
      id:    { type: uuid, posture: allow, pk: true }
      title: { type: text, posture: { read: allow, write: allow } }
      body:  { type: text, posture: { read: allow, write: allow }, searchable: true }
```

Which verbs the flag unlocks is **structural**, decided by the collection's type:

| | File collections | Dataset collections |
|---|---|---|
| Verbs | `create` only | `create`, `update`, `delete` |
| Editing an existing document | Never — it would falsify the ingestion record | Yes, as a new revision |

A collection without `writable: true` is physically untouched — no extra columns,
no extra view predicate, no read cost. `writable: true` with no `write: allow`
field is a config error.

## File collections

```yaml
collections:
  case_files:
    type: file
    description: Client case files
    source: ./seed/case-files-dev        # required — DEV content, committed sample files
    source_live: ./seed/case-files-live  # optional — real content, indexed only with --env live
    taxonomies: [client, tags]           # list of vocabulary slugs
    fields:
      title:           { posture: allow }
      content:         { posture: allow }
      owner:           { posture: allow }
      updated_at:      { posture: allow }
      path:            { posture: deny }   # gates documents, never readable
      matter_number:   { type: text, posture: allow }
      filed_date:      { type: date, posture: allow }
```

The file collection schema includes five fixed fields (`title`, `content`, `path`,
`owner`, `updated_at`) plus any additional metadata fields you declare. `.md` and
`.txt` are parsed; the title comes from the first heading or the filename, `owner`
from frontmatter, `updated_at` from the file mtime. Additional metadata fields are
populated from frontmatter (YAML at the top of the file).

**`source` is dev content by definition.** Point it at committed sample files,
never at real corporate documents. Live content is indexed only by an explicit
`warehousd index <collection> --env live`, which requires `source_live` or an
explicit `--source`.

## Taxonomies

Vocabularies are declared at the top level and bound to collections:

```yaml
taxonomies:
  department:
    label: Department
    terms:
      hr:       { label: HR }
      finance:  { label: Finance }
      security: { label: Security }
  tags:
    label: Tags
    multiple: true
    terms:
      urgent:      { label: Urgent }
      confidential: { label: Confidential }
  client:
    label: Client
    # `clients` must be a dataset collection declaring both named fields.
    source: { collection: clients, slug: client_number, label: name }

collections:
  policies:
    taxonomies: [department, tags]    # list of vocabulary slugs
    fields:
      department:  { posture: allow }  # added automatically; allows restricting posture
      tags:        { posture: allow }
```

- Vocabulary slugs match `[a-z][a-z0-9_]*`, may not contain `__`, and may not
  collide with a reserved column name (`title`, `content`, `path`, `owner`,
  `updated_at`, `id`, `checksum`, `file_id`, `document_seq`, `tsv`, `_rank`).
  A `searchable` field also generates a sibling `<field>_tsv` column, so a
  declared field by that name is rejected at config load rather than colliding
  at DDL time.
- Term slugs are lowercase kebab-case.
- A vocabulary has **either** `terms` (inline YAML) **or** `source` (dataset), not both.
- `multiple: true` makes the column `text[]` (with a GIN index) so a document can
  carry several terms. A grant scoped to such a field uses Postgres array
  **overlap**: the document matches if it carries **at least one** of the granted
  terms. `describe_collection` reports the field as `text[]`, and only `eq` and
  `in` are accepted against it — `gt`, `like` and friends are refused as
  `invalid_intent`.
- **Dataset sourcing** (`source:`) pulls vocabulary terms from a dataset collection —
  the only way to bind a document to a row, since file collections have no foreign
  keys. The `source` object names the collection, the field to use as the term slug,
  and the field to use as the human-readable label. Slugs are slugified and
  lowercased (`C-0042` becomes `c-0042`), so frontmatter must use the lowercase
  form. Two source values that slugify identically are an error rather than a
  silent merge, since merging would widen every grant scoped to that term.
- **Dataset-sourced terms are scoped per environment.** `data_synth` and `data_live`
  hold different rows, so they yield different term sets. `syncDatasetTerms()` must
  run **after** the data exists and **before** any file collection bound to that
  vocabulary is indexed, or indexing fails on an unknown term. The bootstrap order
  is: `applyConfig` → generate/seed → `syncDatasetTerms(dev)` → `seedLive` →
  `syncDatasetTerms(live)` → `indexCollection`. It is also re-run after an admin
  import, so a newly imported client becomes available as a term.
- **A dataset collection may bind one too.** The generator cannot fill such a column
  on the first pass — the terms are distinct values of rows it is still writing — so
  it syncs the dev terms and back-fills the column afterwards, from the same seeded
  RNG. `matters` scoped by `client` therefore generates with real client slugs, not
  NULLs.
- **Import validates against the live term set.** An import naming a
  dataset-sourced term is checked against `app.terms` for `live`, resolved before
  validation runs; an unrecognised value is `unknown_term`. A vocabulary that was
  never applied is `unvalidatable_term` and refuses the file — the default is
  closed, because a term no grant can match is worse than a rejected import. If
  the term store cannot be read at all, the refusal is `taxonomy_unavailable`
  (HTTP 503), kept distinct so an outage never reads as a broken config.
- The bound field is added automatically as `text`/`allow` if you don't declare it.
  Declaring it lets you override the posture; it may not set `pk`, `fk`, or `view_join`.

A grant can be scoped to terms. One limited to `hr` silently excludes `finance`
documents — the user never learns they exist. Grants may carry several predicates,
ANDed together, and they may name any field on the collection — including a
`posture: deny` one, and including a plain metadata field. So a grant can be
scoped to `client = c-0042 AND tags overlapping {litigation, discovery}`, or gated
on a `confidentiality` metadata field that the user can never read.

## Synthetic data

```yaml
synthetic:
  documents_per_collection: { people: 40, salaries: 200, metrics: 730 }
```

How many documents to generate per dataset collection. Generation is
deterministic under `--seed` (default `42`), derived from this schema only, and
honors `fk` and `min`/`max`. It never reads `data_live` — the role it uses has no
privileges there.

## Server environment variables

Set on the container or the dev process, not in YAML:

| Variable | Purpose |
|---|---|
| `APP_DATABASE_URL` | The `app` schema: users, sessions, grants, collections, audit. |
| `DEV_DATABASE_URL` / `LIVE_DATABASE_URL` | The two role-scoped read pools. Optional: when unset, both are derived from `APP_DATABASE_URL` and `WAREHOUSD_DATA_ROLE_PASSWORD`. Set them explicitly only to point the roles at a database the owner URL does not describe. |
| `DEV_WRITE_DATABASE_URL` / `LIVE_WRITE_DATABASE_URL` | The two role-scoped write pools, derived the same way. Absent and underivable means no write path, which is the safer default. |
| `WAREHOUSD_DATA_ROLE_PASSWORD` | Password for the four data roles. Required for the derivation above; the container bootstrap also uses it to create or rotate those roles. |
| `IMPORT_DATABASE_URL` | The admin import role — `INSERT`-only on `data_live`. Unset means no write path at all. |
| `DEV_WRITE_DATABASE_URL` / `LIVE_WRITE_DATABASE_URL` | The per-env write roles behind `broker.mutate`. They hold `INSERT`, `SELECT`, and `UPDATE` on the two revision-bookkeeping columns only — never on a data column, and never `DELETE`. Unset means no mutation path for that env. |
| `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` | Session and token signing; the app's public origin. |
| `WAREHOUSD_PROJECT_DIR` | Where `warehousd.yml` lives (`/project` in the container). |
| `WAREHOUSD_TRUSTED_ORIGINS` | Comma-separated origins allowed as OIDC/SAML issuers. Required for loopback or private-network IdPs — see [configure-sso.md](configure-sso.md). |
| `WAREHOUSD_DISABLE_LOCAL_LOGIN` | `true` forces every sign-in through SSO. |
| `WAREHOUSD_DEMO` | `true` behaves like `demo: true`. |
| `WAREHOUSD_IMAGE` | Server image the CLI should run, if `server.image` is unset. |

### Statement bounds

Every pool carries a `statement_timeout`, so one slow scan cannot hold a
connection indefinitely and exhaust the pool. Two budgets, because the pools do
different work: the query and write pools serve single documents and pages of a
view, while the app and import pools carry real batch work at request time —
`regenerateSynthetic` behind `POST /api/admin/regen-synth`, and file imports.

| Variable | Default | Applies to |
|---|---|---|
| `WAREHOUSD_STATEMENT_TIMEOUT_MS` | `30000` | The `dev` / `live` read pools and the two write pools. |
| `WAREHOUSD_BULK_STATEMENT_TIMEOUT_MS` | `600000` | The `app` and import pools. |
| `WAREHOUSD_CONNECT_TIMEOUT_MS` | `10000` | Acquiring a connection, on every pool. |

`idle_in_transaction_session_timeout` is set to twice the statement bound and is
not separately configurable. It covers the case a statement timeout cannot: every
data-plane call runs inside a transaction, and if the broker stalls between
`begin` and `commit` no statement is running, so the transaction would hold its
locks — and hold back vacuum — indefinitely.

`0` is Postgres's spelling of "no limit" and is accepted, for an operator who has
decided to opt out. A value that is not a number is **ignored** rather than
treated as zero, so a typo cannot silently remove the ceiling it meant to raise.

## A complete example

[`examples/harbor/warehousd.yml`](../examples/harbor/warehousd.yml) is a
working configuration for the demo company: 20 collections including
relational data, sensitive compensation records, a time series, three file
collections with bound taxonomies, and dataset-sourced vocabulary terms.
