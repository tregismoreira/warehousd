# Architecture

How warehousd is put together and why. If you are evaluating whether to trust it
with real data, this is the document to read.

- [Domain model](#domain-model)
- [Security invariants](#security-invariants)
- [The broker](#the-broker)
- [Named views](#named-views)
- [Environments: dev and live](#environments-dev-and-live)
- [Organizations and tenant isolation](#organizations-and-tenant-isolation)
- [Postures, verbs, and writability](#postures-verbs-and-writability)
- [Identity, OAuth, and env-as-scope](#identity-oauth-and-env-as-scope)
- [File collections and search](#file-collections-and-search)
- [Taxonomies](#taxonomies)
- [The app schema](#the-app-schema)
- [The MCP surface](#the-mcp-surface)
- [What the model is trusted with](#what-the-model-is-trusted-with)
- [Adding an adapter](#adding-an-adapter)

## Shape of the system

A modular monolith: one deployable, one Postgres, one hard internal boundary.

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

Adapters translate a protocol into a `BrokerContext` and a query intent, and
nothing else. The broker (`packages/broker`) is a pure library with zero HTTP,
MCP, UI, or LLM imports — an ESLint rule fails the build if that changes — so it
is testable on its own and identical no matter which adapter called it.

## Domain model

**A Collection holds Documents; each Document has Fields.** See
[glossary.md](glossary.md) for why those words and not "table", "row", "item".

| Concept | Definition |
|---|---|
| **Collection** | A named, governed set of documents. `type: dataset` (default) for queryable tables, `type: file` for indexed files. Backed by Postgres tables, one set per environment. |
| **Document** | One governed, queryable record. For dataset collections, one table row. For file collections, one indexed segment of a parsed file. |
| **Field** | A document's governed attribute. Postures and grants operate on fields. |
| **Field posture** | Per-field, two-axis: `{ read, write }`, each `allow` or `deny`, declared in `warehousd.yml`. `deny` means that axis can *never* be granted. `allow` only makes a field **grantable** on that axis — it stays denied per user until a grant covers it. No posture means denied on both. A bare `posture: allow` is read-allow, **write-deny**. |
| **Grant** | `(org, user, collection, purpose, verbs, allowed fields ⊆ grantable fields, env, mode, expires_at, optional document filter)`. Requested by a user, approved by a manager or admin, evaluated at query time. |
| **Verb** | `read`, `create`, `update`, `delete`, `approve`. A grant carries a set. Which verbs a collection can support at all is **structural** — it follows from its type, not from the grant. |
| **Environment** | `dev` or `live`. Dev resolves to synthetic data, live to real data. Carried in the access token, never in a request. |
| **Organization** | The tenant. Every grant, audit event and document belongs to exactly one. Derived from the authenticated user, never from a request. |
| **Purpose** | A short label plus free text, stated at request time and stamped on every audit event the grant produces. |
| **Role** | `admin` (collections, SSO, users, clients, import, audit), `manager` (approves grants, promotes clients), `member` (requests grants, queries). |
| **Audit event** | Immutable record of every broker decision: who, org, env, collection, intent, fields returned, grant id, outcome, timestamp. |

Configuration is declarative and lives in the consuming project's repo — see
[configuration.md](configuration.md).

## Security invariants

Each is enforced structurally rather than by convention, and each is covered by
tests in the suite.

1. **Broker-only data path.** No code outside the broker library reads collection
   tables. Enforced with Postgres role privileges: the app's role has none on
   `data_live` / `data_synth`; the broker holds separate role-scoped pools.
2. **Deny by default.** No posture means denied. No grant means the user sees
   nothing beyond a collection's name and description in `list_collections`.
3. **The client is untrusted.** Query intents are proposals. The broker
   re-validates every one against the grant before constructing SQL, which it
   builds server-side from named views and a fixed operator whitelist. No
   client-supplied SQL fragment reaches the database.
4. **Denied means absent.** Denied fields are excluded at SQL construction — they
   are never selected, so they cannot appear in a response payload, an error
   message, or a log line. Not filtered out afterwards: never fetched.
5. **Dev never touches real data.** Two Postgres roles, two connection pools; the
   token's env scope selects the pool. Synthetic data is generated from the
   schema definition only — never sampled or derived from real rows. A bug in
   schema-name resolution cannot cross the wall, because the database refuses.
6. **Env parity.** Dev and live run identical postures and grant logic. The only
   difference is the source schema; the response shape is the same.
7. **Everything is audited**, before the response is returned — refusals
   included.
8. **Tenants are separated by the database, not by a predicate the broker
   remembers.** See [Organizations](#organizations-and-tenant-isolation).

## The broker

```ts
interface BrokerContext {
  userId: string;
  orgId: string;              // from the token/session's user row, never from a request
  env: "dev" | "live";        // from the token, never from a request body
}

type QueryIntent = {
  collection: string;
  fields?: string[];           // omitted = "every field I'm allowed"
  filters?: Filter[];          // op ∈ eq|neq|gt|lt|gte|lte|like|in
  orderBy?: { field: string; dir: "asc" | "desc" };
  limit?: number;              // default 100, hard cap 500
  offset?: number;
  aggregate?: { fn: "avg"|"sum"|"count"|"min"|"max"; field: string }[];
  groupBy?: string[];          // when `aggregate` is present, `fields` must be omitted
};

type BrokerResult =
  | { ok: true;  documents: Document[]; fieldsReturned: string[]; auditId: string }
  | { ok: false; reason: "no_grant" | "expired_grant" | "field_denied"
               | "unknown_collection" | "unknown_field" | "invalid_intent"
               | "internal_error";
      auditId: string };       // reason codes only — never a denied value, never SQL

broker.query(ctx, intent)
broker.searchDocuments(ctx, intent)     // file collections only
broker.describeCollection(ctx, name)    // only fields visible under the caller's grants
broker.listCollections(ctx)             // names and descriptions only
```

Validation order inside `query` — fail fast, audit every outcome:

intent shape → collection exists → active grant for `(user, collection, env)` →
every requested field ∈ `grant.allowedFields` → every filter and `orderBy` field
∈ `allowedFields` → every `aggregate.field` and `groupBy` field ∈
`allowedFields` → build SQL from the collection's named view in `data_{env}`,
selecting only granted fields → execute → audit → return.

Grants are loaded fresh on every request. Revocation and expiry take effect on
the very next query; nothing about a grant is ever baked into a token.

A driver error becomes `internal_error` and nothing else. Postgres messages name
columns, tables, and values — precisely what invariant 4 forbids leaking — so the
raw error goes to the server log and the caller gets a bare reason code. The
audit row is still written: an unaudited probe would leave no trace.

**Aggregation is permitted only over fields the caller could already read row by
row.** That is deliberate: an aggregate can then never reveal anything new, so no
minimum-group-size or differential-privacy machinery is needed. An
"aggregate-only" posture — compute `avg(base_salary)` without row access — is
explicitly future work, because doing it safely needs inference-leak protection
(an average over a group of one *is* the value).

**Natural language is deliberately absent from the broker.** The MCP client is
the natural-language layer: it turns "average salary for a senior accountant over
the past five years" into a `QueryIntent`. Embedding our own NL→query model would
place an untrusted LLM inside the trust boundary and add a network dependency to
an otherwise offline core. The broker's job is to make the *structured* intent
expressive enough that the assistant can ask real questions.

## Named views

For each collection and environment there is a Postgres view
`data_{env}.v_{collection}` defining the queryable surface. Views may pre-join —
`v_people` joins `departments` for a flat `department_name` — so the MCP surface
stays flat. The broker only ever selects from views, never base tables, and the
env roles hold `SELECT` on the view only.

Views are intentionally *flat*: every field appears regardless of posture. Access
control is enforced at the grant and query layer, not by omitting columns, which
keeps one view valid for every caller. This is why the view's owner role — not
the caller's — is what reads the base tables.

## Environments: dev and live

`data_synth` holds generated data; `data_live` holds real data. Two Postgres
roles exist with privileges on exactly one schema each, and the broker keeps a
connection pool per role. `ctx.env` picks the pool; the schema name is never
interpolated from anything a caller supplied.

Synthetic generation (`packages/broker/src/synthetic`) reads the YAML schema and
nothing else. It is deterministic under a seed, type-aware (names and emails from
wordlists, numerics within the configured `min`/`max`, timestamps over configured
windows, some nulls on nullable fields), and honors declared foreign keys, so
every `salaries.person_id` points at a generated person. It runs with a role that
has no privileges on `data_live`.

The only write path into `data_live` is the admin import (`IMPORT_DATABASE_URL`),
a role with `INSERT` and nothing else — no update, no delete. If that variable is
unset, the import endpoint refuses with `import_not_configured` and there is no
write path at all.

## Identity, OAuth, and env-as-scope

Authentication is [Better Auth](https://better-auth.com): sessions, OIDC and SAML
SSO with JIT provisioning, and an OAuth 2.1 authorization server for MCP clients.
warehousd builds authorization, not authentication.

- **SSO from day one.** An admin registers an IdP in the UI or through
  `/api/sso/providers` — no code change, no redeploy. First SSO login provisions
  the user as `member`; existing accounts are never demoted by linking an
  identity. `WAREHOUSD_DISABLE_LOCAL_LOGIN=true` turns local passwords off
  entirely. See [configure-sso.md](configure-sso.md).
- **warehousd is the OAuth provider.** When a user authorizes an MCP client, the
  login step delegates to the configured IdP — connecting Claude is "log in with
  your company account", never a new password.
- **Tokens carry no grant data** — only subject, client id, and one env scope.

**Environment is never a request parameter.** It exists only as an OAuth scope,
`env:dev` or `env:live`, decided server-side at issuance:

1. Requested scopes are intersected with the client's `allowed_scopes`
   (`app.client_policies`). A client whose policy lacks `env:live` can ask for it
   all day and will only ever receive `env:dev`. Escalation is impossible by
   construction, not by validation.
2. `env:live` is additionally intersected with the *user's* eligibility: at least
   one approved, unexpired `env='live'` grant. Otherwise it is silently dropped,
   even for a live-allowed client.
3. If both survive, the consent step shows an env picker. Exactly one env scope
   ends up in the token — never both.
4. Access tokens are short-lived (15 minutes) with refresh tokens, and the scope
   rules re-run on every refresh. A revoked client promotion or an expired live
   grant takes effect within minutes, without waiting for a logout.

Client registration paths: MCP clients register dynamically (RFC 7591) and get
`{env:dev, env:live}` — rule 2 is the real gate for humans in chat. Clients
created by hand in **Admin → Clients** get `{env:dev}` always, so an app is built
against synthetic data by construction; a manager or admin promotes it later,
which is the entire "ship to production" step. Demotion narrows it back on the
next refresh.

Adapters derive the context in exactly one place:

```ts
const token = await auth.verifyAccessToken(req);        // signature + expiry
const env = token.scopes.includes("env:live") ? "live" : "dev";
const orgId = await orgOfUser(token.sub);               // from the user row, not the token
const ctx: BrokerContext = { userId: token.sub, orgId, env };
// Any env-like or org-like value in the request body or params is ignored and never read.
```

## File collections and search

A `type: file` collection points at a directory of `.md`/`.txt` files. Its
grantable schema is fixed — `title`, `content`, `path`, `owner`, `updated_at`
(plus a bound taxonomy field) — and the YAML `fields` block only sets postures on
those.

**Storage.** Per environment and collection: a `{collection}__files` table (one
row per source file, `path` unique as the upsert key, `checksum` for idempotent
re-index) and a `{collection}__documents` table (segments of ~500–1000 characters
with overlap, a generated `tsv` column with a GIN index, and a reserved
`embedding vector(1536)` column that nothing populates yet). The queryable
surface is, as always, the view `v_{collection}` — one row per document with file
metadata joined on. Collection names may not contain `__`, which is reserved for
these tables.

**Indexing.** The indexer scans the environment-appropriate source directory,
extracts text (title from the first heading or the filename, owner from
frontmatter, updated_at from mtime), segments it into documents, and upserts —
skipping unchanged files by checksum and deleting rows for files removed from
disk. `source` is *dev* content by definition; live content is indexed only by an
explicit `--env live` with `source_live` or `--source`. The CLI never indexes one
directory into both environments.

**Search.** `broker.searchDocuments` reuses the same validation pipeline and the
same SQL builder, adding `tsv @@ websearch_to_tsquery('english', $n)` to the
WHERE clause and ordering by `ts_rank_cd`. Only granted fields are selected;
`tsv` and an ungranted `path` never appear in a response. Result rows carry
reserved `_rank` and `document_seq` keys that are never part of `fieldsReturned`.
`searchDocuments` on a dataset collection returns `invalid_intent`;
`broker.query` on a file collection works normally, which gives document listing
for free.

**Document-level scoping.** A grant may carry a `document_filter` —
`{ field, op: "eq" | "in", value }` — restricting which documents it reaches. Its
field is validated against the collection's *YAML field set*, not the user's
allowed fields: that is what lets a denied field like `path` gate documents
without ever being readable. It is author-supplied at approval time, never
client-supplied. It is ANDed into the same parameterized WHERE machinery as
client filters, an empty `in` list compiles to constant-false rather than a SQL
error, and excluded documents are silently absent rather than a distinguishable
refusal.

The value may be the sentinel **`$self`**, bound to the calling user's id when
the grant is loaded:

```yaml
document_filter: { field: owner, op: eq, value: $self }
```

That makes "lower-level roles see and edit only what is assigned to them" a
property of the *grant* rather than of application logic. Binding happens in
`loadActiveGrant`, so no caller can forget it and the SQL builder still sees a
plain literal. Only the exact string `$self` is a sentinel — `$self-service` is
a literal, and there is no substring interpolation. A partial unique index guarantees at most one approved grant per
`(user, collection, env)`, so a second, broader grant can never silently override
the restriction.

## Organizations and tenant isolation

Every deployment has at least one organization. An existing single-tenant install
gets one implicit org, `default`, created at bootstrap, and behaves exactly as it
did before — `org_id` defaults to it on every table.

`org_id` is on `app.collections`, `app.grants`, `app.audit_events`,
`app.client_policies`, Better Auth's `user`, and every data table in
`data_synth` / `data_live`. Grant lookup keys on
`(org_id, user_id, collection, env)`.

**`ctx.orgId` is derived from the verified session or token, never from the
request** — the same rule as `ctx.env`. A caller cannot name its own tenant any
more than it can name its own environment.

Isolation is enforced **in the database, twice**, because two different kinds of
role reach the data by two different routes:

```sql
-- the wall for the read roles, which only ever see the view
create or replace view data_live.v_pages as
  select ... from data_live.pages base
  where base.org_id = current_setting('warehousd.org_id', true);

-- the wall for roles that touch base tables directly (import, and the write roles)
alter table data_live.pages enable row level security;
create policy org_isolation on data_live.pages
  using      (org_id = current_setting('warehousd.org_id', true))
  with check (org_id = current_setting('warehousd.org_id', true));
```

The broker sets `warehousd.org_id` transaction-locally from `ctx.orgId` before
any data statement (`withOrg` in `db/pools.ts`); `set_config(..., true)` means a
pooled connection can never leak one org's setting into another's query. **The
broker's generated SQL contains no org predicate at all** — that is deliberate,
and a test asserts it. A bug in the broker cannot cross the tenant wall, exactly
as a bug in schema-name resolution cannot cross the env wall (invariant 5).

The two-argument `current_setting` returns NULL when the setting is absent, so an
unset org yields no rows rather than all rows. **It fails closed.**

The control plane is the other half, and it has no view and no RLS policy behind
it: `/api/grants`, `/api/audit`, `/api/me/*` and `/api/admin/users` read
`app.*` directly, so each carries the org predicate itself. The grant decision
functions (`approveGrant`, `denyGrant`, `revokeGrant`) scope by org as well as
id; an omitted org scopes to the implicit one, which fails to find a foreign
grant rather than finding one.

## Postures, verbs, and writability

A posture has **two axes**. A bare value sets the read axis and leaves write
denied, so every configuration written before the write path existed stays valid
and nothing becomes writable by accident:

```yaml
email:       { type: text,    posture: allow }                        # read allow, write deny
base_salary: { type: numeric, posture: { read: deny, write: allow } }
```

`view_join` fields are **always** write-deny, structurally — a joined view is not
updatable in Postgres and the field belongs to another collection anyway. Asking
for `write: allow` on one is a config error, not a silent override.

A grant carries **verbs**: `read`, `create`, `update`, `delete`, `approve`.
Existing grants are `['read']`. A grant without `read` refuses reads with
`no_grant` — not a distinct code, because "you have a grant but not for reading"
would be an information leak.

Two rules are enforced at approval time, in one place
(`validateVerbs`), so no approval path can skip them:

- **`approve` requires `read`.** You cannot approve what you cannot see; without
  this, "approve, then read the diff" is a privilege-escalation path around field
  postures. Read is *not* required in general — an append-only ingestion grant
  (`create`, no `read`) is legitimate and forcing `read` onto it would widen
  access rather than narrow it.
- **Verb support is structural.** It follows from the collection's type, so
  `update` on a file collection is refused regardless of what an approver asks
  for. File collections are a record of what was *ingested*; dataset collections
  are a record of what is currently *true*. You append to the former and revise
  the latter.

`writable: true` on a collection opts it into the write path. Collections that do
not opt in are physically untouched — no extra columns, no extra view predicate,
no read cost.

`searchable: true` on a dataset text field generates the same `tsv` column and
GIN index the file branch already emits, and makes `broker.searchDocuments` work
against datasets. A dataset with no searchable field still refuses
`invalid_intent`.

## Taxonomies

A vocabulary is declared once under `taxonomies` and bound to a collection with
`taxonomy: <slug>`. The bound field is a normal text field on the collection —
auto-added as `allow` if the YAML omits it — and terms are validated against the
vocabulary. A grant scoped to `hr` compiles to a document filter over that field,
so `finance` documents are silently absent: the user never learns they exist.
Vocabulary slugs may not collide with the fixed file fields or the structural
columns (`id`, `checksum`, `file_id`, `document_seq`, `tsv`, `_rank`).

## The app schema

```sql
-- Better Auth manages: user, session, account, sso_provider, oauth_client
-- (user gains an orgId column via additionalFields)
create table app.organizations (id text pk, name text, created_at timestamptz);

create table app.collections (
  name text pk, description text, config jsonb, org_id text, updated_at timestamptz);

create table app.grants (
  id uuid pk, org_id text references organizations,
  user_id text references "user", collection text references collections,
  purpose_label text, purpose_detail text,
  allowed_fields text[],            -- ⊆ the collection's grantable fields
  verbs text[] not null default '{read}',   -- read|create|update|delete|approve
  mode text not null default 'direct',      -- direct | proposal_only
  document_filter jsonb,            -- optional, author-supplied; null = whole collection
                                    -- value may be the sentinel $self, bound at eval time
  env text check (env in ('dev','live')),
  status text check (status in ('pending','approved','denied','revoked')),
  requested_at timestamptz, decided_at timestamptz, decided_by text, expires_at timestamptz
);
create unique index grants_one_active
  on app.grants (org_id, user_id, collection, env) where status = 'approved';

create table app.client_policies (
  client_id text pk references oauth_client,
  display_name text, org_id text references organizations,
  allowed_scopes text[] not null default '{env:dev}',
  promoted_at timestamptz, promoted_by text
);

create table app.audit_events (
  id uuid pk, at timestamptz, user_id text, org_id text, env text, collection text,
  intent jsonb, fields_returned text[], grant_id uuid, outcome text, reason text
);
-- audit_events is INSERT-only for the app role: no UPDATE, no DELETE privilege.
```

Drizzle manages the `app` schema. `warehousd apply` owns everything in
`data_synth` and `data_live` — tables and views — idempotently, diffing against
`app.collections.config`. Broker data queries and view DDL are raw SQL through
`pg` with the two role-scoped pools.

## The MCP surface

One OAuth-protected endpoint at `/mcp`, streamable HTTP.

| Tool | Behavior |
|---|---|
| `list_collections` | Names and descriptions only — no schema, no counts. |
| `describe_collection` | Only the fields visible under the caller's grants. |
| `query_collection` | Filters, ordering, limits, aggregation — re-validated, then executed. |
| `search_documents` | Ranked full-text search over a file collection, grant-filtered. |
| `request_access` | Opens a pending grant request for a manager to approve. |

Refusals return a reason code plus a request-access hint — never a denied value,
never SQL. Tool descriptions state the governance model plainly: the model
reading them is the first consumer of the security posture.

Clients find the authorization server through the standard discovery documents
under `app/.well-known/`: `oauth-authorization-server` (RFC 8414) and
`oauth-protected-resource` (RFC 9728). A connector needs only the `/mcp` URL —
the rest is discovered.

## What the model is trusted with

Nothing. Two failure modes are handled separately.

**Its tool calls are untrusted proposals**, re-validated by the broker like any
other caller's. That is the whole architecture above.

**Its final text answer is untrusted output too.** Observed in practice: asked
for salary data with no grant, a model ignored the `no_grant` tool result and
produced a plausible table of invented salaries, admitting they were fabricated
only when challenged. The built-in chat console defends against this in two
layers: the system prompt forbids fabricating, guessing, or simulating data
absent from a tool result even under repeated pressure; and a server-side guard
scans the conversation for `query_collection` results with `ok: true`, and if the
model's final text contains a table or multiple currency figures while that set
is empty, injects a corrective message rather than streaming the fabrication.
This is a targeted heuristic, not a grounding check — it catches the observed
failure mode cheaply. Any adapter that puts an LLM in front of the broker should
assume it needs its own version.

## Adding an adapter

An adapter is thin by construction. To add one — REST, a CMS delivery API, a
scheduled export:

1. Authenticate the caller and derive `BrokerContext` in one place, from a
   verified token. Never read an env-like value from the request.
2. Translate the protocol into a `QueryIntent` or `DocSearchIntent`.
3. Call the broker. Return `documents` and `fieldsReturned` on success; on
   refusal, return the reason code — never a denied value, never SQL.
4. Do not query `data_live` or `data_synth`. The role you are given cannot
   anyway, and that is the point.

`broker.query` is read-only. Naming is deliberately kept open for an additive
`broker.mutate` with its own validation and audit; the audit outcome column is
not called `query_outcome` for that reason.
