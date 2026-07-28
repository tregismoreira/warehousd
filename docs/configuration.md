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
    taxonomy: category                     # optional — bind a vocabulary
    fields:
      id:              { type: uuid, posture: allow, pk: true }
      full_name:       { type: text, posture: allow }
      email:           { type: text, posture: allow }
      department_id:   { type: uuid, posture: allow, fk: departments.id }
      department_name: { type: text, posture: allow, view_join: departments.name }
      home_address:    { type: text, posture: deny }
```

A collection name may not contain `__` — that is reserved for file-collection
storage tables. Field names must match `[a-z_][a-z0-9_]*` (case-insensitive);
anything else is rejected at config load rather than reaching DDL.

### Field options

| Key | Meaning |
|---|---|
| `posture` | **Required.** `allow` or `deny`. |
| `type` | Required on dataset collections: `uuid`, `text`, `numeric`, `int`, `timestamptz`, `date`, `boolean`, `json`. Inferred for file collections. |
| `pk` | Marks the primary key. |
| `fk` | `collection.field` — honored by the synthetic generator so references resolve. |
| `view_join` | `collection.field` — pre-joined into `v_<collection>` so the queryable surface stays flat. |
| `nullable` | Lets the generator produce nulls. |
| `min` / `max` | Range for generated numerics. |

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
  policies:
    type: file
    description: Company policy documents
    source: ./seed/docs-dev        # required — DEV content, committed sample files
    source_live: ./seed/docs-live  # optional — real content, indexed only with --env live
    taxonomy: category
    fields:
      title:      { posture: allow }
      content:    { posture: allow }
      owner:      { posture: allow }
      updated_at: { posture: allow }
      path:       { posture: deny }   # gates documents, never readable
```

The schema is fixed: only `title`, `content`, `path`, `owner`, `updated_at` (plus
the bound taxonomy field) may appear, and the `fields` block only sets their
postures. `.md` and `.txt` are parsed; the title comes from the first heading or
the filename, `owner` from frontmatter, `updated_at` from the file mtime.

**`source` is dev content by definition.** Point it at committed sample files,
never at real corporate documents. Live content is indexed only by an explicit
`warehousd index <collection> --env live`, which requires `source_live` or an
explicit `--source`.

## Taxonomies

```yaml
taxonomies:
  category:
    label: Category
    terms:
      hr:       { label: HR }
      finance:  { label: Finance }
      security: { label: Security }

collections:
  policies:
    taxonomy: category    # binds the vocabulary; adds a `category` text field
```

- Vocabulary slugs match `[a-z][a-z0-9_]*`, may not contain `__`, and may not
  collide with a reserved column name (`title`, `content`, `path`, `owner`,
  `updated_at`, `id`, `checksum`, `file_id`, `document_seq`, `tsv`, `_rank`).
- Term slugs are lowercase kebab-case.
- The bound field is added automatically as `text`/`allow` if you don't declare
  it. Declaring it lets you set a different posture; it may not set `pk`, `fk`,
  or `view_join`.

A grant can be scoped to terms. One limited to `hr` silently excludes `finance`
documents — the user never learns they exist.

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

[`examples/meridian/warehousd.yml`](../examples/meridian/warehousd.yml) is a
working configuration for the demo company: six collections including a
relational pair, a sensitive one, a time series, and a file collection with a
bound taxonomy.
