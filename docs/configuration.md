# Configuration reference

`warehousd.yml` is the source of truth. It lives at the root of the project that *uses* **warehousd** — not inside warehousd's own repo — so governance is reviewed and versioned in the same pull requests as the app it governs.

`warehousd init` scaffolds it; `warehousd start` and `warehousd apply` apply it idempotently.

## File resolution

| File | Role |
|---|---|
| `warehousd.yml` | Committed. The source of truth. |
| `warehousd.local.yml` | Optional, gitignored. Deep-merged over the base — personal ports, smaller document counts, a real connection string. |

`${env:VAR_NAME}` anywhere in either file is replaced with that environment variable, so secrets never live in YAML. An unresolved reference is a hard error at load. Variable names must match `[A-Z0-9_]+`. References inside YAML comments are left alone.

Config is **trusted input** — whoever can write these files already decides what is grantable.

## Top level

```yaml
project: acme          # required. Namespace for containers, volumes, and state
demo: false            # default false. true seeds the three demo personas
audit:
  enabled: true        # default true. false records nothing at all
  sink: postgres       # postgres (default) | stdout-json | webhook
  url: ...             # webhook only. Where to POST each decision
  headers: {...}       # webhook only. Extra request headers
  timeout_ms: 5000     # webhook only. Default 5000. Giving up is a FAILED write
server:
  port: 8722           # default 8722
  image: ...           # optional. Override the published server image
database:
  managed: true        # default: the CLI runs Postgres in Docker
  url: ${env:DATABASE_URL}   # alternative: bring your own Postgres
  port: 5432           # host port for the managed Postgres (default: server.port + 1)
sources:                 # optional. External databases to read through — see Connect-in-place
  crm:
    type: postgres
    url: ${env:CRM_DATABASE_URL}
    schema: public       # default public
embedding:               # optional. Absent means semantic search is off
  provider: local        # local (default) | openai | http
  model: bge-small-en-v1.5
  dimensions: 384        # required — must match the model
sso:                     # optional. Absent means every SSO user is provisioned `member`
  providers:
    okta-oidc:           # the providerId the IdP was registered under
      group_claim: groups
      groups:
        wh-admins: admin
        wh-managers: manager
      default_role: member   # default member
workspaces:
  enabled: false        # default false. true mounts /v1/platform/* and `warehousd platform-key`
deploy:
  target: fly          # fly | railway | compose
  app_name: harbor-warehousd   # ^[a-z0-9][a-z0-9-]{0,62}$; the Fly app, Railway project
                               # or Compose service name, so unique where the target requires it
  region: gru          # whatever the target calls a region; checked at pre-flight, not here
  image: warehousd:local   # optional — override the published base image
  database:            # exactly one of the three shapes below
    managed: true      # 1. let the target provision Postgres
    # provider: supabase              # 2. or add this, and warehousd creates one there
    # region: sa-east-1               #    required with a provider — the database's region
    # org: abcdefgh                   #    Supabase only, when the account has more than one
    # url: ${env:PROD_DATABASE_URL}   # 3. or attach a Postgres you already run
    # provider: supabase              #    optional there; usually detected from the host
taxonomies: {}         # see below
collections: {}        # required
synthetic:
  documents_per_collection: {}
```

Setting `database.url` skips the managed Postgres container entirely. The server still runs as a container, and `warehousd stop --destroy` will not touch a database it does not manage.

`database.provider` is the third option for local development: `managed: true` with `provider: supabase` runs `supabase start` instead of warehousd's own `pgvector` container. It is heavier — that stack boots Auth, Storage and Studio alongside Postgres — and it is worth it for one reason: local Supabase installs `pgcrypto` into an `extensions` schema rather than `public`, exactly as the hosted product does. That is the difference behind the failure [deploy-database.md](deploy-database.md) calls the bad one, where `apply` and boot both succeed and the first masked read fails at request time. Only a provider with a local stack is accepted here, so `provider: neon` is refused by name. It does not apply alongside `url` — a provider names who *runs* the database, which says nothing about one you point at.


`demo: true` seeds `ana@demo.local` (admin), `marcus@demo.local` (manager), and `mia@demo.local` (member), all with the password `demo`, and shows them on the login page. **Never enable it on a deployment reachable by anyone else.**

`audit.enabled: false` turns the audit trail off for the whole deployment. Nothing is written to `app.audit_events` — allows, refusals and imports alike — and every result comes back with `auditId: null` instead of a row id. Decisions themselves are unchanged: a refusal still refuses, a grant is still required, and the only difference is that no record survives the response. This exists for lower environments; `warehousd deploy` refuses a project configured this way unless you pass `--allow-disabled-audit`, and the admin audit page says plainly that it is off rather than showing an empty table.

Because it is a plain boolean it overrides cleanly per machine, either from `warehousd.local.yml`:

```yaml
audit: { enabled: false }
```

or from the environment, since `${env:…}` is substituted before the YAML is parsed and so yields a real boolean:

```yaml
audit: { enabled: ${env:WAREHOUSD_AUDIT} }   # WAREHOUSD_AUDIT=false
```

`audit.sink` decides where a decision goes. `postgres` writes `app.audit_events` and is the only sink the console can query — the audit browser and the access-review view read that table, so a deployment that forwards elsewhere keeps the trail and loses the console's view of it. `stdout-json` writes one JSON object per decision on stdout for a log pipeline to collect; `webhook` POSTs each decision to `audit.url` and needs it.

Whatever the sink, the rule that makes the trail worth having is unchanged: a decision that could not be recorded is not an allow. A sink that cannot accept an event — a non-2xx from the collector, a closed pipe — turns the allow it was recording into an `internal_error` refusal. `webhook` is therefore synchronous with the decision and not queued, and a slow collector slows every governed call. That is the cost of the guarantee.

Because it is synchronous, the wait is bounded: `audit.timeout_ms` (default 5000, maximum 60000) is how long the collector has to answer, and running out of time counts as a failed write like any other — so the call is refused rather than allowed, and never left hanging. A collector that accepts the connection and then goes quiet would otherwise hold every governed call open for as long as the platform allows.

The `sso:` block maps an identity provider's groups to warehousd roles at JIT provisioning. It lives here rather than alongside the provider registration because a provider is registered at runtime through the admin API, while this file is operator-controlled trusted input — and a rule that decides who becomes an admin belongs in the trusted file. See [configure-sso.md](configure-sso.md#4-map-idp-groups-to-warehousd-roles).

`workspaces.enabled` defaults to `false`. A single enterprise's self-hosted deployment, the primary shape of this product, has exactly one workspace (`default`) and no reason to carry a provisioning API, which is why this ships off. It gates exactly these four things, and nothing else:

| Off | On |
| --- | --- |
| `/v1/platform/*` returns 404 on every route and method | routes mounted |
| `warehousd platform-key create` refuses, naming the key to set | works |
| `admin/members` page and its route are absent | present |
| the console workspace switcher never renders | renders when membership count > 1 |

What the flag never touches, in either state: the `workspace_id` column on any table, RLS policies and view predicates, `withWorkspace` and the `warehousd.workspace_id` GUC, membership-based role resolution in `authz.ts` and `acl/manage.ts`, `workspace_id` on audit events, and `resolveWorkspace` at all three auth boundaries. With the flag off, the deployment has exactly one workspace, every user is a member of it at bootstrap, and every one of those mechanisms runs exactly as it does with the flag on. **Turning it on adds no enforcement and removes none**; it exposes the means to create a second workspace. For provisioning workspaces once it's on, see [multi-tenancy.md](multi-tenancy.md).

The `deploy:` block is optional and required only by `warehousd deploy`. It names the target — `fly`, `railway` or `compose` — the app name, the region, and — most critically — **exactly one** of `managed: true` or a `database.url`. An `image:` override is optional; if unset, the published image is used. `warehousd init --target <id>` scaffolds the block. `region` is optional here — Compose has none to name — and everything about it belongs to the target's pre-flight: Fly and Railway refuse its absence there, and what a region *looks* like is theirs too, which is why `us-west2` and `gru` are both valid in this file and only one of them is valid for a given target. The runbooks are [deploy-fly.md](deploy-fly.md), [deploy-railway.md](deploy-railway.md) and [deploy-compose.md](deploy-compose.md).

`deploy.database.provider` answers one of two questions depending on the company it keeps. Alongside `managed: true` it names who should **create** the database — `supabase` or `neon`, the two with a CLI warehousd can drive — and `region` becomes required. Alongside `url` it names who **hosts** the one you attached: `supabase`, `neon`, `railway` or `generic`. In that second reading it is normally unnecessary — the host says so on its own — and only matters where it changes how a role is spelled in a connection string, which today means Supabase's pooler. Setting it without a `url` is an error, and so is setting it to a provider the host contradicts: role names are derived per provider, so the wrong one produces a role that cannot authenticate. A value over a host nothing recognises is left alone — that is the CNAME case the key exists for. `warehousd deploy` also runs a set of `db-*` pre-flight checks against that URL, which `warehousd doctor --deploy` runs on their own. See [deploy-database.md](deploy-database.md).

## Collections

```yaml
collections:
  people:
    description: Employee directory        # required — this is what `list_collections` returns
    type: dataset                          # dataset (default) | file
    taxonomies: [department]               # optional — bind one or more vocabularies
    grant_expiry_days: 30                  # optional — default expiry for an approved grant
    import:                                # optional — spreadsheet header → field
      columns:
        "Base Salary (USD)": base_salary
        "Start Date": hire_date
    fields:
      id:              { type: uuid, posture: allow, pk: true }
      full_name:       { type: text, posture: allow }
      email:           { type: text, posture: allow }
      department_id:   { type: uuid, posture: allow, fk: departments.id }
      department_name: { type: text, posture: allow, view_join: { table: departments, column: name, on: department_id } }
      home_address:    { type: text, posture: deny }
```

Collection and field names must both match `[a-z_][a-z0-9_]*` (case-insensitive), and a collection name may not contain `__` — that is reserved for file-collection storage tables. Anything else is rejected at config load rather than reaching DDL.

`grant_expiry_days` is the expiry stamped on an approved grant when the approver names none of their own; an approver's explicit choice always wins, and a collection that declares nothing keeps the old behaviour of no expiry. It is per collection because the answer is not uniform — a salaries collection wants thirty days and a public announcements one wants none. Grants lapsing within a week appear in the manager inbox, and **Access review** lists every approved grant older than a chosen window with when it was last exercised.

`import.columns` maps a spreadsheet's HEADER to a field on this collection, and is resolved before the field lookup — so `Base Salary (USD)` reaches `base_salary` instead of reporting `unknown_column`, without anyone editing the sheet. It is deliberately not the `column:` key on a field, which means "the column's name on the remote table" and is only valid alongside `source_ref`. A mapping naming a field that does not exist is a config parse error, not an import-time one: the person holding the spreadsheet cannot fix the config.

`warehousd import map <file>` proposes a block like this from a real spreadsheet, and prints it for review rather than writing it — see [cli.md](cli.md).

### Field options

| Key | Meaning |
|---|---|
| `posture` | **Required.** `allow` / `deny`, or `{ read: allow\|mask\|deny, write: …, unmask: … }`. |
| `type` | Required on dataset collections: `uuid`, `text`, `numeric`, `int`, `timestamptz`, `date`, `boolean`, `json`. Inferred for file collections. |
| `pk` | Marks the primary key. On a `writable` dataset this is *document* identity, not row identity. |
| `fk` | `collection.field` — honored by the synthetic generator so references resolve. |
| `view_join` | `{ table, column, on }` — pre-joined into `v_<collection>` so the queryable surface stays flat. Always write-deny. See below. |
| `nullable` | Lets the generator produce nulls, and makes the column optional on import. Not a database constraint — every column is nullable in Postgres either way (see below). |
| `min` / `max` | Range for generated numerics. |
| `gen` | Names a synthetic generator for this field, overriding the field-name heuristics. See below. |
| `searchable` | Dataset text fields only. Generates a `<field>_tsv` column and GIN index so `search_documents` reaches this collection. |
| `mask` | Required with `read: mask`, invalid without it. The transform applied in SQL — see [Masking](#masking). |
| `column` | Only on a `source_ref` collection: the column's name on the remote table, when it differs. |

Changing `type` on a field, removing a field, or moving `pk` is a **breaking change** once a collection holds live content: `apply` refuses it rather than leaving the column and the config disagreeing about what it holds. See [migrations.md](migrations.md) for the flow that gets you past it.

#### `nullable`

`nullable` governs three things: whether the synthetic generator emits the occasional NULL, whether import treats a missing value as `missing_required`, and whether a write payload may state the field as an explicit `null` — a `nullable: true` field accepts one and stores SQL NULL, a field without it refuses one with `invalid_value`. It never becomes a `not null` constraint — every column on a dataset collection is nullable in Postgres, `nullable: true` or not.

It cannot become one. Cyclic and self-referential foreign keys are inserted NULL and back-filled in a second pass, so `people.department_id` is genuinely NULL between the two — a `not null` column would make the generator impossible to run.

Read the flag as "this field is optional in the data I expect", not as a guarantee the database enforces.

#### `view_join`

```yaml
responsible_attorney_id:   { type: uuid, posture: allow, fk: people.id }
responsible_attorney_name: { type: text, posture: allow,
                             view_join: { table: people, column: full_name, on: responsible_attorney_id } }
```

`on` must name a sibling field declared `fk: <table>.id` pointing at the same table; all three conditions are checked at config load. Each join gets its own alias (`j_<field_name>`), so one collection may join the same table several times — two attorneys on a matter, or `people.manager_id` back to `people`.

The column is derived, so it exists only on the view: it is never stored, and an import naming it is rejected as a `derived_column`.

#### `gen`

Field-name heuristics cover the generic cases (`*_email`, `*_name`, `*_address`). `gen` is for the ones they cannot tell apart — `matter_number`, `bar_number`, `client_number` and `invoice_number` are all `*number*`:

```yaml
client_number: { type: text, posture: allow, gen: client_number }
```

Available: `client_number`, `matter_number`, `invoice_number`, `bar_number` (dense deterministic sequences derived from the row index — `C-0001`, `C-0002`, …), `company_name`, `industry`, `court_name`, `narrative`, `hourly_rate`.

The sequence hints are dense and stable for a given row count, which is what lets committed seed documents reference a generated row by slug. Shrinking a collection's row count below a slug a document names breaks indexing loudly.

### Postures are two-tier, on three axes

A posture governs reading, writing, and unmasking separately:

```yaml
email:       { type: text,    posture: allow }                        # read allow, write deny
base_salary: { type: numeric, posture: { read: deny, write: allow } }
```

- `deny` on an axis — the field can **never** be granted for it. It cannot be requested, cannot be approved, and is never selected. Changing that requires editing this file.
- `allow` on an axis — the field is *grantable* for it. It is still denied for every user until a manager approves a grant covering it.
- A field with no posture is denied on every axis.
- **A bare `allow` or `deny` sets the read axis and leaves write denied.** That is what keeps every configuration written before the write path existed valid, and stops any field becoming writable by accident.
- `view_join` fields are always write-deny. Asking for `write: allow` on one is a config error, not a silent override.

Denied fields are still useful: a denied `path` on a file collection can gate which documents a grant reaches without ever being readable.

### Masking

`read: mask` is the third setting on the read axis. The field is grantable, and what a grant gets back is a **transformed** value rather than the stored one:

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

The transform is computed **in SQL**, so the raw value is never fetched — it cannot appear in a response, an error body or a log line, which is the same standard `deny` sets. Masking applied after the rows came back would fail all four and look identical in a passing test.

`unmask: allow` is the second tier, and it works exactly like `read: allow`: it makes the raw value **grantable**, not readable. A manager still has to tick it per grant, and the audit row records which fields a decision returned unmasked. Omit it and nobody sees the raw value without editing this file.

| transform | types | result |
| --- | --- | --- |
| `redact` | any | `[redacted]` |
| `last4` | text | `••••4321` |
| `first: { chars: N }` | text | the first N characters, then `…` |
| `hash` | any | a keyed HMAC — equal values hash equal, so rows still group |
| `bucket: { width: N }` | numeric, int | quantised down to the band below |
| `year` | date, timestamptz | the year alone |
| `domain` | text | whatever follows the `@` |

`hash` needs `WAREHOUSD_MASK_KEY`. `warehousd start` and `warehousd deploy` generate one per project into `.warehousd/state.json` and ship it with the other secrets; set it by hand only when running the image without the CLI. There is deliberately no baked-in default: a default key is a public key, and the point of `hash` is a pseudonym only this deployment can correlate.

**A masked field can be projected and nothing else.** It cannot appear in `filters`, `orderBy`, `groupBy` or `aggregate` — those refuse with `field_denied`. This is not a limitation to work around; it is what makes the mask real. A banded salary you can still compare against falls to bisection in about ten queries, `like` walks a redacted string one character at a time, and `min`/`max` return the raw extremes outright.

A grant's own `document_filter` is the deliberate exception and may still reference a masked column — it is written by a human manager rather than by the model, the same reason a denied `path` can gate documents.

Refused at config load, because each one is a way for a mask to look applied and not be: masking a `pk` (identity has to round-trip), masking a `searchable: true` field (the generated `<field>_tsv` column indexes the raw value), masking a file collection's `content` or `path`, a transform its column type cannot compute, and `unmask: allow` on a field that is not masked.

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

A collection without `writable: true` is physically untouched — no extra columns, no extra view predicate, no read cost. `writable: true` with no `write: allow` field is a config error.

### Per-document ACLs

```yaml
collections:
  content:
    description: Authored pages
    acl: true                 # opt in; default false
    fields:
      id:    { type: uuid, posture: allow, pk: true }
      title: { type: text, posture: allow }
```

A grant scopes to a *set* of documents. `acl: true` adds the orthogonal rule that lets you exempt an individual one:

> A document with **no ACL** is readable by anyone the grant covers. A document **with an ACL** is readable only by the principals listed on it.

An ACL never widens a grant — it only takes one document out of one — and it applies to every verb and to every aggregate: a `count` over the collection counts what the caller may see.

Principals are namespaced, `user:<id>` and `group:<name>`. Groups are warehousd's own record (`app.user_groups`), synced from an IdP's group claim on login or pinned in the console; they are never read from a token.

ACLs are edited through `PUT /v1/collections/{c}/documents/{id}/acl` or the console's **Access** tab, not through MCP — an untrusted proposer must not be able to widen access. A REST caller needs `can_manage_acl` on its client policy, which an admin grants per client in **Admin → Clients**; a console user needs the `manager` or `admin` role. An empty principal list removes the restriction.

Group membership is managed by the IdP — its group claim is persisted on every SSO login, see [configure-sso.md](configure-sso.md#5-map-idp-groups-to-warehousd-roles-optional) — or by an admin through `PUT /api/admin/users/{id}/groups`, which owns the `manual` source. Neither source overwrites the other, so a deployment with no SSO at all still gets working groups.

**A file collection is addressed by `path`.** Its documents are chunks of a file, so the policy attaches to the file and every chunk of it shares one — and the id you pass to the ACL endpoint is the path, not the `file_id`:

```yaml
collections:
  policies:
    description: Policy documents
    type: file
    source: ./policies
    acl: true
    fields:
      title:   { posture: allow }
      content: { posture: allow }
      path:    { posture: deny }
```

```
PUT /v1/collections/policies/documents/hr%2Fpto.md/acl
{ "principals": ["group:legal"] }
```

The restriction survives the file's own lifecycle: a re-index that changes the content keeps it, and so does the file leaving the source directory and coming back. The second is why `path` is the key rather than the `file_id` — the sweep removes the row, so a returning file gets a new id, and an ACL keyed on that id would leave the document readable by everyone the grant covers.

Requirements and current limits, all enforced at config load:

| Rule | Why |
|---|---|
| A dataset requires a field with `pk: true` | An ACL is keyed on document identity; a file collection uses `path` |
| Refused with `source_ref` | warehousd does not own those rows |
| `_acl` is a reserved field name | It is the ACL column on the collection's view |

A collection without `acl: true` gets no join and no predicate, so it pays nothing. A collection with it pays one left join, and a document with no ACL row costs nothing beyond that.

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

The file collection schema includes five fixed fields (`title`, `content`, `path`, `owner`, `updated_at`) plus any additional metadata fields you declare. `.md` and `.txt` are parsed; the title comes from the first heading or the filename, `owner` from frontmatter, `updated_at` from the file mtime. Additional metadata fields are populated from frontmatter (YAML at the top of the file).

**`source` is dev content by definition.** Point it at committed sample files, never at real corporate documents. Live content is indexed only by an explicit `warehousd index <collection> --env live`, which requires `source_live` or an explicit `--source`.

## Semantic search

```yaml
embedding:
  provider: local            # runs in-process, nothing leaves the machine
  model: bge-small-en-v1.5
  dimensions: 384
```

Absent, and semantic search is simply off: `search_documents` behaves exactly as it always has and the embedding column stays empty. That is the honest default — embedding a corpus costs something, and for a remote provider it is a disclosure.

`dimensions` has no default because it has to match the model. Get it wrong and Postgres reports a cast error on insert that names neither the model nor this key, so warehousd checks it at construction instead.

`provider: local` is the default deliberately. An embedding request is the whole document text, and warehousd's argument is that governed content does not leave the deployment. Sending it to an API is a legitimate trade — a better model is a better search — but it is one someone states in writing:

```yaml
embedding:
  provider: openai           # or `http`, which requires base_url
  model: text-embedding-3-small
  dimensions: 1536
  api_key: ${env:OPENAI_API_KEY}
```

Fill the column with `warehousd embed`, which is resumable — it only ever touches chunks that have none, so an interrupted run costs nothing already done. `warehousd index` and `warehousd seed` embed new chunks as they go when `embedding:` is configured; `--no-embed` skips that.

The `search_documents` tool then takes a `mode`:

| mode | ranking |
|---|---|
| `text` (default) | `ts_rank_cd` over the full-text index — matches words |
| `semantic` | cosine distance over the embedding — matches meaning, and will find a document that shares no words with the query |
| `hybrid` | Reciprocal Rank Fusion over both |

Semantic and hybrid apply to file collections only, and refuse rather than silently falling back to a text search: a caller who asked for one and got the other has no way to tell.

## PDF and DOCX

`.pdf` and `.docx` are indexed alongside `.md` and `.txt`, from the same `source` directory, with the original bytes stored so the console can hand the document back.

A binary has no frontmatter, so its owner, terms and typed metadata come from a **sidecar** beside it — `contract.pdf` is described by `contract.pdf.yml`:

```yaml
owner: legal@acme.example
client: c-0001
tags: [urgent, confidential]
review_date: 2026-06-01
```

The rule that a bound vocabulary is *required* still holds: a binary with no sidecar term fails the index rather than becoming a document no grant can scope. A scanned PDF with no extractable text is refused too — OCR is out of scope, and storing an empty document is the failure that looks like success.

## Uploading documents from the console

Copying files into `source` and running `warehousd index <collection>` is one way in. **Admin → Documents** is the other: pick files or a whole folder, fill in the owner, terms and metadata the form derives from the collection's own configuration, and upload. Both paths run the same ingestion code, so a document is indistinguishable downstream from one indexed off disk — same chunking, same checksum, same required-term rule.

Uploads are **resumable, and the resume is answered by the database**. Each file is hashed in the browser, the console asks which of those hashes the collection already holds, and only the rest are sent — four at a time, each retried on a transport failure. So an interrupted upload of three thousand documents is resumed by picking the same folder again: everything that landed is skipped, from any browser, on any machine, with nothing remembered locally.

Two differences from a directory index are worth knowing:

- **An upload is not a mirror.** `warehousd index` deletes a document whose file has left the source directory; an uploaded document was never in one, so it is left alone. The `origin` column is what tells them apart.
- **The form fills in what the file does not say.** A `.md` or `.txt` carries its own frontmatter and that always wins; the form's owner, terms and metadata fill gaps, and are the only source for a PDF or DOCX.

`WAREHOUSD_MAX_UPLOAD_BYTES` caps a single file (default 25 MB). Deleting a document and downloading its original are both admin-only and both audited.

## Connect-in-place

A collection can read from an external Postgres instead of storing rows in warehousd:

```yaml
sources:
  crm:
    type: postgres
    url: ${env:CRM_DATABASE_URL}
    schema: public

collections:
  accounts:
    description: CRM accounts
    source_ref: { source: crm, table: accounts, workspace: default }
    fields:
      id:   { type: uuid, posture: allow, pk: true }
      name: { type: text, posture: allow, column: acct_name }
      tier: { type: text, posture: allow }
```

The connection is made by `postgres_fdw` — by **Postgres**, not by warehousd. A foreign table lives inside `data_live`, so the collection's view, its grant, its field postures and the broker's SQL builder all work on it completely unchanged.

Three consequences worth knowing before you point one at production:

- **`url` is dialled by the database server**, so the host and port have to be reachable *from Postgres*, which is not always the address your client uses. A warehousd running its own Postgres in a container cannot reach a source published on that container's host port.
- **Columns are declared, never imported.** A column added upstream is invisible to warehousd until someone writes it into the YAML. `warehousd apply` verifies the remote actually matches and fails naming the collection if it does not.
- **Read-only, and not by convention.** The server and the foreign table are both `updatable 'false'`, and no role is granted anything but `SELECT` on the wrapping view. `writable: true` is a config error on these collections.

**Connect-in-place does not generalise to many workspaces.** A foreign table has no `workspace_id` column — the remote system knows nothing about warehousd's tenants — so RLS cannot apply to it, and the live view instead compares the caller's active workspace against the single constant `source_ref.workspace` names in config. That pins the collection to exactly one workspace: a caller active in any other workspace reads zero rows, not an error, just an empty result. This is unsupported in a multi-workspace deployment rather than silently wrong for one — a connect-in-place collection is a single-tenant source multiplexed into a multi-tenant deployment at one fixed workspace, not a per-tenant one.

`dev` is unaffected: an external collection gets an ordinary synthetic table in `data_synth`, so developers never touch the remote system and env parity holds.

The one genuine narrowing is tenant isolation. A foreign table cannot carry an RLS policy and has no `workspace_id` column, so the view compares the request's workspace against the `workspace:` the source declares — one wall instead of two. See [architecture.md](architecture.md).

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

- Vocabulary slugs match `[a-z][a-z0-9_]*`, may not contain `__`, and may not collide with a reserved column name (`title`, `content`, `path`, `owner`, `updated_at`, `id`, `checksum`, `file_id`, `document_seq`, `tsv`, `_rank`). A `searchable` field also generates a sibling `<field>_tsv` column, so a declared field by that name is rejected at config load rather than colliding at DDL time.
- Term slugs are lowercase kebab-case.
- A vocabulary has **either** `terms` (inline YAML) **or** `source` (dataset), not both.
- `multiple: true` makes the column `text[]` (with a GIN index) so a document can carry several terms. A grant scoped to such a field uses Postgres array **overlap**: the document matches if it carries **at least one** of the granted terms. `describe_collection` reports the field as `text[]`, and only `eq` and `in` are accepted against it — `gt`, `like` and friends are refused as `invalid_intent`.
- **Dataset sourcing** (`source:`) pulls vocabulary terms from a dataset collection — the only way to bind a document to a row, since file collections have no foreign keys. The `source` object names the collection, the field to use as the term slug, and the field to use as the human-readable label. Slugs are slugified and lowercased (`C-0042` becomes `c-0042`), so frontmatter must use the lowercase form. Two source values that slugify identically are an error rather than a silent merge, since merging would widen every grant scoped to that term.
- **Dataset-sourced terms are scoped per environment.** `data_synth` and `data_live` hold different rows, so they yield different term sets. `syncDatasetTerms()` must run **after** the data exists and **before** any file collection bound to that vocabulary is indexed, or indexing fails on an unknown term. The bootstrap order is: `applyConfig` → generate/seed → `syncDatasetTerms(dev)` → `seedLive` → `syncDatasetTerms(live)` → `indexCollection`. It is also re-run after an admin import, so a newly imported client becomes available as a term.
- **A dataset collection may bind one too.** The generator cannot fill such a column on the first pass — the terms are distinct values of rows it is still writing — so it syncs the dev terms and back-fills the column afterwards, from the same seeded RNG. `matters` scoped by `client` therefore generates with real client slugs, not NULLs.
- **Import validates against the live term set.** An import naming a dataset-sourced term is checked against `app.terms` for `live`, resolved before validation runs; an unrecognised value is `unknown_term`. A vocabulary that was never applied is `unvalidatable_term` and refuses the file — the default is closed, because a term no grant can match is worse than a rejected import. If the term store cannot be read at all, the refusal is `taxonomy_unavailable` (HTTP 503), kept distinct so an outage never reads as a broken config.
- The bound field is added automatically as `text`/`allow` if you don't declare it. Declaring it lets you override the posture; it may not set `pk`, `fk`, or `view_join`.

A grant can be scoped to terms. One limited to `hr` silently excludes `finance` documents — the user never learns they exist. Grants may carry several predicates, ANDed together, and they may name any field on the collection — including a `posture: deny` one, and including a plain metadata field. So a grant can be scoped to `client = c-0042 AND tags overlapping {litigation, discovery}`, or gated on a `confidentiality` metadata field that the user can never read.

## Synthetic data

```yaml
synthetic:
  documents_per_collection: { people: 40, salaries: 200, metrics: 730 }
```

How many documents to generate per dataset collection. Generation is deterministic under `--seed` (default `42`), derived from this schema only, and honors `fk` and `min`/`max`. It never reads `data_live` — the role it uses has no privileges there.

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
| `WAREHOUSD_TRUSTED_ORIGINS` | Comma-separated origins allowed as OIDC/SAML issuers and as browser sign-in origins. Every IdP's issuer origin must be listed — `warehousd deploy` derives it from `SSO_ISSUER` when unset, and a Compose deploy adds `http://localhost:<server.port>` — see [configure-sso.md](configure-sso.md). |
| `WAREHOUSD_DISABLE_LOCAL_LOGIN` | `true` forces every sign-in through SSO. |
| `WAREHOUSD_DEMO` | `true` behaves like `demo: true`. |
| `WAREHOUSD_IMAGE` | Server image the CLI should run, if `server.image` is unset. |

### Statement bounds

Every pool carries a `statement_timeout`, so one slow scan cannot hold a connection indefinitely and exhaust the pool. Two budgets, because the pools do different work: the query and write pools serve single documents and pages of a view, while the app and import pools carry real batch work at request time — `regenerateSynthetic` behind `POST /api/admin/regen-synth`, and file imports.

| Variable | Default | Applies to |
|---|---|---|
| `WAREHOUSD_STATEMENT_TIMEOUT_MS` | `30000` | The `dev` / `live` read pools and the two write pools. |
| `WAREHOUSD_BULK_STATEMENT_TIMEOUT_MS` | `600000` | The `app` and import pools. |
| `WAREHOUSD_CONNECT_TIMEOUT_MS` | `10000` | Acquiring a connection, on every pool. |

`idle_in_transaction_session_timeout` is set to twice the statement bound and is not separately configurable. It covers the case a statement timeout cannot: every data-plane call runs inside a transaction, and if the broker stalls between `begin` and `commit` no statement is running, so the transaction would hold its locks — and hold back vacuum — indefinitely.

`0` is Postgres's spelling of "no limit" and is accepted, for an operator who has decided to opt out. A value that is not a number is **ignored** rather than treated as zero, so a typo cannot silently remove the ceiling it meant to raise.

## A complete example

[`examples/harbor/warehousd.yml`](../examples/harbor/warehousd.yml) is a working configuration for the demo company: 20 collections including relational data, sensitive compensation records, a time series, three file collections with bound taxonomies, dataset-sourced vocabulary terms, one writable collection behind the proposal path, and one (`announcements`) with per-document ACLs turned on.
