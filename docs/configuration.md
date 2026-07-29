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
| `posture` | **Required.** `allow` or `deny`. |
| `type` | Required on dataset collections: `uuid`, `text`, `numeric`, `int`, `timestamptz`, `date`, `boolean`, `json`. Inferred for file collections. |
| `pk` | Marks the primary key. |
| `fk` | `collection.field` — honored by the synthetic generator so references resolve. |
| `view_join` | `{ table, column, on }` — pre-joined into `v_<collection>` so the queryable surface stays flat. See below. |
| `nullable` | Lets the generator produce nulls, and makes the column optional on import. |
| `min` / `max` | Range for generated numerics. |
| `gen` | Names a synthetic generator for this field, overriding the field-name heuristics. See below. |

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

### Postures are two-tier

- `posture: deny` — the field can **never** be granted. It cannot be requested,
  cannot be approved, and is never selected. Changing that requires editing this
  file.
- `posture: allow` — the field is *grantable*. It is still denied for every user
  until a manager approves a grant covering it.
- A field with no posture is denied. There is no third state.

Denied fields are still useful: a denied `path` on a file collection can gate
which documents a grant reaches without ever being readable.

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
| `DEV_DATABASE_URL` / `LIVE_DATABASE_URL` | The two role-scoped data pools. |
| `IMPORT_DATABASE_URL` | The admin import role — `INSERT`-only on `data_live`. Unset means no write path at all. |
| `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` | Session and token signing; the app's public origin. |
| `WAREHOUSD_PROJECT_DIR` | Where `warehousd.yml` lives (`/project` in the container). |
| `WAREHOUSD_TRUSTED_ORIGINS` | Comma-separated origins allowed as OIDC/SAML issuers. Required for loopback or private-network IdPs — see [configure-sso.md](configure-sso.md). |
| `WAREHOUSD_DISABLE_LOCAL_LOGIN` | `true` forces every sign-in through SSO. |
| `WAREHOUSD_DEMO` | `true` behaves like `demo: true`. |
| `WAREHOUSD_IMAGE` | Server image the CLI should run, if `server.image` is unset. |
| `ANTHROPIC_API_KEY` | Only for the built-in `/console` chat page. |

## A complete example

[`examples/harbor/warehousd.yml`](../examples/harbor/warehousd.yml) is a
working configuration for the demo company: nineteen collections including
relational data, sensitive compensation records, a time series, three file
collections with bound taxonomies, and dataset-sourced vocabulary terms.
