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
- [Revisions, and immutability by privilege](#revisions-and-immutability-by-privilege)
- [The write path: broker.mutate](#the-write-path-brokermutate)
- [Proposals](#proposals)
- [The change feed](#the-change-feed)
- [Client credentials and the collection ceiling](#client-credentials-and-the-collection-ceiling)
- [Full-document reads](#full-document-reads)
- [Per-document ACLs](#per-document-acls)
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
│  ├── REST (/v1)  (token-authenticated HTTP)     │
│  └── [future]    CMS delivery, apps             │
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

| Concept           | Definition                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Collection**    | A named, governed set of documents. `type: dataset` (default) for queryable tables, `type: file` for indexed files. Backed by Postgres tables, one set per environment.                                                                                                                                                                       |
| **Document**      | One governed, queryable record. For dataset collections, one table row. For file collections, one indexed segment of a parsed file.                                                                                                                                                                                                           |
| **Field**         | A document's governed attribute. Postures and grants operate on fields.                                                                                                                                                                                                                                                                       |
| **Field posture** | Per-field, two-axis: `{ read, write }`, each `allow` or `deny`, declared in `warehousd.yml`. `deny` means that axis can _never_ be granted. `allow` only makes a field **grantable** on that axis — it stays denied per user until a grant covers it. No posture means denied on both. A bare `posture: allow` is read-allow, **write-deny**. |
| **Grant**         | `(org, user, collection, purpose, verbs, allowed fields ⊆ grantable fields, env, mode, expires_at, optional document filter)`. Requested by a user, approved by a manager or admin, evaluated at query time.                                                                                                                                  |
| **Verb**          | `read`, `create`, `update`, `delete`, `approve`. A grant carries a set. Which verbs a collection can support at all is **structural** — it follows from its type, not from the grant.                                                                                                                                                         |
| **Environment**   | `dev` or `live`. Dev resolves to synthetic data, live to real data. Carried in the access token, never in a request.                                                                                                                                                                                                                          |
| **Organization**  | The tenant. Every grant, audit event and document belongs to exactly one. Derived from the authenticated user, never from a request.                                                                                                                                                                                                          |
| **Purpose**       | A short label plus free text, stated at request time and stamped on every audit event the grant produces.                                                                                                                                                                                                                                     |
| **Role**          | `admin` (collections, SSO, users, clients, import, audit), `manager` (approves grants, promotes clients), `member` (requests grants, queries).                                                                                                                                                                                                |
| **Audit event**   | Immutable record of every broker decision: who, org, env, collection, intent, fields returned, grant id, outcome, timestamp.                                                                                                                                                                                                                  |

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

   The enforcement point is `packages/broker/src/intents/schema.ts`, applied at
   the _top of every broker verb_ rather than in the adapters. That placement is
   what makes the invariant hold rather than merely be true today: both adapters
   parse as well, so a malformed body answers 400 before it costs a grant lookup,
   but a new adapter that forgets cannot reintroduce the hole — it has to pass
   through the verb. A parse failure returns `invalid_intent` through the normal
   refusal path, so the probe is audited (invariant 7).

   `fn` and `op` are the only intent values that reach the SQL text as syntax
   rather than as bound parameters; both are `z.enum`, and `sql/build.ts` re-checks
   them against the same lists rather than trusting the parse. Field names are only
   ever identifiers, quoted through `sql/ident.ts`, drawn from the collection's
   declared set.

   Covered by `packages/broker/test/sql-build.test.ts` — the injection payload for
   `fn`, `op: "constructor"`, and a non-integer `limit`, each asserting a refusal
   rather than a driver error — and over the wire by
   `apps/web/test/rest-api.integration.test.ts` and
   `apps/web/test/mcp-tools.test.ts`.

4. **Denied means absent.** Denied fields are excluded at SQL construction — they
   are never selected, so they cannot appear in a response payload, an error
   message, or a log line. Not filtered out afterwards: never fetched.
5. **Dev never touches real data.** Two Postgres roles, two connection pools; the
   token's env scope selects the pool. Synthetic data is generated from the
   schema definition only — never sampled or derived from real rows. A bug in
   schema-name resolution cannot cross the wall, because the database refuses.
6. **Env parity.** Dev and live run identical postures and grant logic. The only
   difference is the source schema; the response shape is the same.
7. **Every decision passes through exactly one audit call**, before the response
   is returned — refusals included — and the configured sink decides whether
   that call lands in a row. With the trail on, which is the default, an allow
   whose row could not be written is downgraded to `internal_error` rather than
   returned unrecorded. A deployment can turn the trail off with
   `audit.enabled: false` for lower environments; then nothing is recorded and
   every `auditId` is null. Nothing ever invents an id to stand in for a row
   that is not there.
8. **Tenants are separated by the database, not by a predicate the broker
   remembers.** See [Organizations](#organizations-and-tenant-isolation).

## The broker

```ts
interface BrokerContext {
  userId: string;
  orgId: string;              // from the token/session's user row, never from a request
  env: "dev" | "live";        // from the token, never from a request body
  allowedCollections?: string[] | null;   // the client's ceiling; null = none. Only narrows.
  via: string;                // session | oauth | token_exchange | api_key:<id>
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
  | { ok: true;  documents: Document[]; fieldsReturned: string[]; auditId: string | null }
  | { ok: false; reason: "no_grant" | "expired_grant" | "field_denied"
               | "unknown_collection" | "unknown_field" | "invalid_intent"
               | "not_found" | "internal_error";
      auditId: string | null }; // reason codes only — never a denied value, never SQL
                                // null id: audit is off (ok) or the row failed (refusal)

broker.query(ctx, intent)
broker.searchDocuments(ctx, intent)     // file collections, and datasets with a searchable field
broker.getDocument(ctx, { collection, id | path })   // one document, full granted field set
broker.mutate(ctx, intent)              // create | update | delete, on a writable collection
broker.listProposals(ctx, opts)         // pending revisions the caller may approve — metadata only
broker.approveProposal(ctx, { proposalId })
broker.rejectProposal(ctx, { proposalId })
broker.changes(ctx, { since, limit })   // control-plane feed; metadata only, no field data
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
error goes to the server log and the caller gets a bare reason code. The audit
row is still written: an unaudited probe would leave no trace. (Unless the
deployment set `audit.enabled: false`, which is the one way to have no trace on
purpose — see invariant 7.)

### Logging

Invariant 4 ends "…or a log line", and that clause is the one that is easy to
lose. A response is obviously a place a denied value must not appear; a log is
not obviously anything, until you notice that the driver error you logged for
debugging carries the row that failed. Postgres puts it in `DETAIL` — `Key
(home_address)=(…) already exists` — so logging a `pg` error whole is a way for a
denied field to reach a log line while every response stayed correctly clean.

`redact()` in `packages/broker/src/log/redact.ts` is the policy in code. It masks
credentials and grant material (passwords, tokens, cookies, client secrets), the
field names the example config denies, and the `pg` error fields that carry row
values — `detail`, `where`, `internalQuery`. It deliberately keeps the error's
`message`: that names the constraint rather than the value, and is what makes the
log worth having. `packages/cli/src/ui/mask.ts` does the same job for values the
CLI prints to an operator.

Be honest about what this is: **defence in depth, not the control.** Redaction is
key-name-based, so it cannot catch a denied value that arrives under a name it
does not know. The control is that the broker never selects a denied field in the
first place. What keeps the two aligned is the probe suite, which plants canaries
and greps every response, error and captured log line for them — including raw
`process.stdout` and `process.stderr`, because Next.js and Better Auth write
there rather than through `console`. See [testing.md](testing.md).

**Aggregation is permitted only over fields the caller could already read row by
row.** That is deliberate: an aggregate can then never reveal anything new, so no
minimum-group-size or differential-privacy machinery is needed. An
"aggregate-only" posture — compute `avg(base_salary)` without row access — is
explicitly future work, because doing it safely needs inference-leak protection
(an average over a group of one _is_ the value).

**Natural language is deliberately absent from the broker.** The MCP client is
the natural-language layer: it turns "average salary for a senior accountant over
the past five years" into a `QueryIntent`. Embedding our own NL→query model would
place an untrusted LLM inside the trust boundary and add a network dependency to
an otherwise offline core. The broker's job is to make the _structured_ intent
expressive enough that the assistant can ask real questions.

## Named views

For each collection and environment there is a Postgres view
`data_{env}.v_{collection}` defining the queryable surface. Views may pre-join —
`v_people` joins `departments` for a flat `department_name`, and `v_matters` joins
`clients` and `people` twice (for responsible and originating attorney), so the MCP
surface stays flat. The broker only ever selects from views, never base tables, and the
env roles hold `SELECT` on the view only.

Views are intentionally _flat_: every field appears regardless of posture. Access
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

An import either lands whole or not at all. Every outcome that reaches the broker
is audited through the app pool — the writer of the data is deliberately not the
writer of its own audit trail. The three request-shape rejections below are
refused by the route before the broker sees them, and `import_not_configured`
returns before anything is attempted, so those four carry no audit row.

A refusal carries a `reason`, and the admin UI shows it verbatim, so these are
the codes to look up:

| `reason`                | HTTP | Meaning                                                                                                                      |
| ----------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| `unsupported_format`    | 400  | Not `csv` or `json`.                                                                                                         |
| `no_file`               | 400  | No file part, or an empty one.                                                                                               |
| `file_too_large`        | 413  | Over 5 MB.                                                                                                                   |
| `parse_failed`          | 400  | Malformed CSV or JSON.                                                                                                       |
| `validation_failed`     | 400  | The payload was checked against the config and rejected. Carries a per-row `errors` list — see below.                        |
| `constraint_violation`  | 400  | Postgres refused a row (`23xxx`): duplicate key, missing FK, failed check. Nothing was written.                              |
| `write_failed`          | 400  | Any other database error during the insert.                                                                                  |
| `import_not_configured` | 503  | `IMPORT_DATABASE_URL` is unset, so there is no write path at all.                                                            |
| `taxonomy_unavailable`  | 503  | A bound vocabulary's terms could not be read. Distinct from the config being wrong: the file may be fine and worth retrying. |

The two 503s mean the stack cannot serve the request; the file itself may be
perfectly good. That distinction is the point — an admin should never be sent to
fix a vocabulary that was never broken. Note that `write_failed` is also a stack
fault but is still returned as 400, which is a rough edge rather than a decision.

Inside `validation_failed`, each entry names a row and column: `unknown_column`,
`derived_column` (a `view_join` field, which has no stored column),
`missing_required`, `ragged_rows`, `duplicate_pk`, `unknown_term`,
`unvalidatable_term` (a vocabulary this stack never applied), the `invalid_*`
type-coercion codes, and the whole-payload codes `unknown_collection`,
`file_collection` (files are ingested by the indexer), `no_rows` and
`too_many_rows`. Reasons never carry the offending value: an import file may hold
real personal data and an error body is still a response body.

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

Two controls sit on the local-credential path, for the deployments that keep it
enabled:

- **Per-account lockout.** Five failures within fifteen minutes lock an address
  for fifteen minutes, and the lock refuses the *correct* password too — one that
  the right password walks through protects nothing. The existing limiters are
  per-IP (Better Auth) and per-client (`/v1/token`), so neither sees a guess
  spread thinly across addresses. Attempts against addresses that are not
  accounts are counted identically, so the lock cannot be used to enumerate
  users, and a lock is not extended by continued guessing — that would hand an
  attacker a denial of service against the account's owner. Failures outside the
  window do not accumulate: a stale row is collected on the next failed attempt,
  which is also what stops a spray of distinct addresses growing
  `app.login_attempts` without bound. A row carrying a live lock is never
  collected, or waiting out the window would be easier than waiting out the lock.
- **An origin check on sign-in and sign-up.** Better Auth's own `originCheck`
  guards routes carrying a redirect target and validates *that URL*, which makes
  `trustedOrigins` an open-redirect allowlist rather than a CSRF one. Nothing
  gated the credential endpoints on `Origin`, and a cross-site form-encoded POST
  is a "simple request" that gets no CORS preflight — so it succeeded, and the
  browser honoured the `Set-Cookie`, logging the victim into an account the
  attacker controls. `middleware.ts` refuses an `Origin` that is present and
  untrusted. A request with no `Origin` passes: browsers always send it
  cross-site, so its absence is a server or a CLI. The SAML assertion callback is
  exempt by design — it is a legitimate cross-origin POST from the IdP.

**Environment is never a request parameter.** It exists only as an OAuth scope,
`env:dev` or `env:live`, decided server-side at issuance:

1. Requested scopes are intersected with the client's `allowed_scopes`
   (`app.client_policies`). A client whose policy lacks `env:live` can ask for it
   all day and will only ever receive `env:dev`. Escalation is impossible by
   construction, not by validation.
2. `env:live` is additionally intersected with the _user's_ eligibility: at least
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
const token = await auth.verifyAccessToken(req); // signature + expiry
const env = token.scopes.includes("env:live") ? "live" : "dev";
const orgId = await orgOfUser(token.sub); // from the user row, not the token
const ctx: BrokerContext = { userId: token.sub, orgId, env };
// Any env-like or org-like value in the request body or params is ignored and never read.
```

## File collections and search

A `type: file` collection points at a directory of `.md`/`.txt` files. Its
grantable schema includes five fixed fields — `title`, `content`, `path`, `owner`,
`updated_at` (plus any bound taxonomy fields) — and additional metadata fields
declared in the YAML `fields` block. Metadata fields are populated from frontmatter
in the source files.

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
disk. `source` is _dev_ content by definition; live content is indexed only by an
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
a **list** of `{ field, op: "eq" | "in", value }` predicates, ANDed — restricting
which documents it reaches. Every predicate's field is validated against the
collection's _YAML field set_, not the user's allowed fields: that is what lets a
denied field like `path` gate documents without ever being readable, and equally
what lets a plain metadata field like `confidentiality` gate them. The list is
author-supplied at approval time, never client-supplied — the approver picks
values, the server decides which column those values gate. Because predicates AND
rather than take precedence over one another, one grant can be scoped across two
vocabularies and a path at once. They compile into the same parameterized WHERE
machinery as client filters, an empty `in` list compiles to constant-false rather
than a SQL error, and excluded documents are silently absent rather than a
distinguishable refusal.

A predicate's value may be the sentinel **`$self`**, bound to the calling user's
id when the grant is loaded:

```yaml
document_filter: [{ field: owner, op: eq, value: $self }]
```

That makes "lower-level roles see and edit only what is assigned to them" a
property of the _grant_ rather than of application logic. Binding happens in
`loadActiveGrant`, per predicate and per element inside an `in` list, so no
caller can forget it and the SQL builder still sees a plain literal. Only the
exact string `$self` is a sentinel — `$self-service` is a literal, and there is
no substring interpolation. A partial unique index guarantees at most one approved grant per
`(user, collection, env)`, so a second, broader grant can never silently override
the restriction.

**One rule, two evaluators.** A document filter is evaluated in SQL on the read
path (`sql/build.ts`, appended to the WHERE clause) and in process on the write
path (`grants/filters.ts`, against a row already fetched). The write path cannot
reuse the read path's SQL: it reads base tables for the `_rev*` bookkeeping
columns, and the view deliberately hides pending and deleted revisions. Two
evaluators for one rule is a correctness hazard — whenever they disagree, the same
grant admits a row on read and refuses it on write — so the invariant is stated
narrowly and tested directly:

> For every filter `validateDocumentFilters` admits, the in-process evaluator
> returns exactly what `col = $1` returns in the database.

The guarantee is _not_ that JavaScript reproduces Postgres's input parsing, which
is not tractable: `'tr'::boolean` is true, `'1e2'::numeric` is 100, and a
timestamp carrying no zone is resolved in the server's timezone rather than the
broker process's. Instead both sides are canonicalised to a string that compares
exactly, and a value that cannot be canonicalised with certainty is **refused on
both paths** as `invalid_intent` rather than evaluated by one and not the other.
So the set of filters that can exist is the set the two paths provably agree on.
`packages/broker/test/filter-parity.test.ts` asserts the agreement case by case
against a live Postgres, and separately asserts it end to end — one grant, one
row, `query` and `mutate` reaching the same verdict.

Refused for that reason: a `json` field (jsonb equality is structural, and the
previous string coercion made such a filter match _every_ row), a `view_join`
field (computed by the view, absent from the base table the write path reads), a
zone-less timestamp, and any value that is not a valid instance of its column's
declared type.

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

A posture has **three axes**. A bare value sets the read axis and leaves write
denied, so every configuration written before the write path existed stays valid
and nothing becomes writable by accident:

```yaml
email: { type: text, posture: allow } # read allow, write deny
base_salary: { type: numeric, posture: { read: deny, write: allow } }
```

The read axis has three settings, not two: `allow`, `mask`, `deny`. `mask` is a
disclosure **level** between the other two — the field is grantable, and what a
grant receives is a transformed value computed in SQL, so the raw one is never
fetched. `unmask: allow` is the third axis and makes the raw value *grantable*,
one more application of the same two-tier rule the other axes use: the config
sets a ceiling, a grant decides who reaches it, and the audit row records which
fields a decision actually returned unmasked.

Masking is sound only for projection, so the broker refuses a masked field in
`filters`, `orderBy`, `groupBy` and `aggregate` (`collectComputed` in
`verbs/read.ts`). A masked field that can still be compared against is not
masked: ordering comparisons recover a banded number by bisection, `like` walks a
redacted string, and `min`/`max` return the raw extremes. The one exception is a
grant's own `document_filter`, which is author-supplied by a manager rather than
by the model — the same exception that lets a denied `path` gate documents.

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
  postures. Read is _not_ required in general — an append-only ingestion grant
  (`create`, no `read`) is legitimate and forcing `read` onto it would widen
  access rather than narrow it.
- **Verb support is structural.** It follows from the collection's type, so
  `update` on a file collection is refused regardless of what an approver asks
  for. File collections are a record of what was _ingested_; dataset collections
  are a record of what is currently _true_. You append to the former and revise
  the latter.

`writable: true` on a collection opts it into the write path. Collections that do
not opt in are physically untouched — no extra columns, no extra view predicate,
no read cost.

`searchable: true` on a dataset text field generates the same `tsv` column and
GIN index the file branch already emits, and makes `broker.searchDocuments` work
against datasets. A dataset with no searchable field still refuses
`invalid_intent`.

### A live grant cannot be approved by the person who asked for it

`approveGrant` refuses with `self_approval_denied` when `grant.env` is `live` and
`grant.user_id` is the approver. It is the same rule `approveProposal` applies to
a pending revision — see [Approval authorization](#approval-authorization) — and
the same reason code, mapped to 403 by `lib/rest.ts`.

Without it, a manager could hand themselves access to real data in two calls and
the audit trail would show a decision with one name on both sides of it. The
request is left `pending` rather than denied, so another approver can still
decide it; the requester simply is not that approver.

**`dev` is deliberately exempt.** Its rows are `generateSynthetic` output,
regenerable from the console's overview page, and a rule that makes someone wait
for a colleague to unlock fabricated data is a rule they learn to route around.
This is also what gives the console's environment switcher a concrete meaning: on
`dev` the "Request & approve access" button in the data browser completes both
legs; on `live` the approve leg comes back `self_approval_denied` and the UI says
the request is waiting for somebody else.

## Revisions, and immutability by privilege

A `writable: true` **dataset** is append-only. There is no in-place `UPDATE` of
data, and no config knob to allow one. Its declared `pk` stops being row identity
and becomes **document identity**:

```sql
create table data_live.pages (
  _rev uuid primary key default gen_random_uuid(),
  _rev_seq bigint not null,          -- monotonic per document
  _rev_at timestamptz not null default now(),
  _rev_by text not null,             -- the author, not the approver
  _rev_op text not null,             -- create | update | delete
  _rev_status text not null,         -- pending | approved | rejected
  _rev_fields text[] not null,       -- which fields this revision touches
  _rev_base bigint,                  -- the _rev_seq it was derived from
  _current boolean not null default false,
  org_id text not null,
  id uuid not null,                  -- the declared pk; no longer unique
  ...);
create unique index on data_live.pages (org_id, id) where _current;
```

- **Exactly-one-current is a database guarantee** — the partial unique index —
  not an ordering convention.
- **Pending revisions have `_current = false`**, so they never contend for that
  index. Multiple proposals can coexist against one document, and the proposed
  after-state is never readable through the view.
- **Delete is a tombstone revision.** No `DELETE` privilege is granted anywhere,
  and the view's `_rev_op <> 'delete'` predicate makes the document disappear
  from reads while the history stays.
- **`_rev*` and `org_id` can never be granted.** They are not in `warehousd.yml`,
  so no grant can name them and `describe_collection` never shows them.
  Bookkeeping is invisible to the query surface for free, with no filtering code.

**File collections keep their existing shape.** No revision columns, no
migration: a `create` appends a file row plus its derived chunks, `path` stays
unique so a repeat is a `conflict`, and chunks are never re-derived — which is
why the "search still returns pre-edit text" bug class cannot occur here.

Turning `writable: true` on over a collection that already has a plain table
**fails the apply** with an operator-facing error. Migrating existing rows into
revisions is deferred, and silently emitting a table that cannot hold a revision
would be worse than refusing.

### Immutability is enforced by privilege, not by code

Two new roles, `warehousd_dev_write` and `warehousd_live_write`, mirror the read
split. Their grants are column-level:

```sql
grant insert on data_live.pages to warehousd_live_write;
grant update (_current, _rev_status) on data_live.pages to warehousd_live_write;
grant select on data_live.pages to warehousd_live_write;   -- concurrency checks and merges
```

**Postgres itself refuses any change to a data column**, and no role anywhere
holds `DELETE`. A broker bug cannot rewrite history. The write role's `select` on
the base table is confined to one tenant by the RLS policy above — that is
precisely the case RLS exists for, since the write role bypasses the view.

If `DEV_WRITE_DATABASE_URL` / `LIVE_WRITE_DATABASE_URL` are unset there is no
mutation path at all, which is the safer default.

## The write path: `broker.mutate`

```ts
type MutationIntent =
  | { collection: string; op: "create"; values: Record<string, unknown> }
  | {
      collection: string;
      op: "update";
      id: string;
      expect?: string;
      values: Record<string, unknown>;
    }
  | { collection: string; op: "delete"; id: string; expect?: string };

type MutationResult =
  | { ok: true; status: "applied"; documentId: string; rev: string; auditId: string | null }
  | { ok: true; status: "pending"; proposalId: string; auditId: string | null }
  | { ok: false; reason: MutationRefusalReason; auditId: string | null };
```

`MutationRefusalReason` extends the read set with `verb_denied`,
`verb_not_supported`, `field_not_writable`, `conflict`, `invalid_value` and
`not_writable`.

Validation order — fail fast, audit every outcome, mirroring `query`:

collection exists → collection is writable → op supported for this collection
type → active grant for `(org, user, collection, env)` → verb ∈ `grant.verbs` →
every field exists → no field is `view_join` → every field write-allowed by
posture → every field ∈ `grant.allowedFields` → coerce to declared types →
target document passes the document filter → concurrency check → append revision
→ promote → audit → return.

**Identity is not content.** The declared pk (dataset) and `path` (file) address
a document rather than describing it, so they are exempt from the write posture
on `create` — a create must be able to name what it creates. Requiring
`write: allow` on a pk would assert the opposite of what is true, namely that
identity may later be changed. On `update` and `delete` they are refused
outright: changing identity is not an edit.

**The audit intent records the op and the field _names_, never the values.** A
write payload can carry real personal data and an audit row is readable by every
admin — a deliberate departure from `query`, whose intent is safe to store
verbatim.

Refusals carry a reason code and nothing else. `coerce()` is reused from the
import path because its reasons already never echo the offending value; its
granular type codes are collapsed to `invalid_value` at the broker boundary,
since naming a type is itself a small disclosure.

**Concurrency.** `expect` is the `_rev` the caller last saw; a mismatch is
`conflict`. On promotion the old revision is demoted _before_ the new one is
inserted — both would otherwise be `_current` between the two statements and the
partial unique index would reject the write.

## Proposals

`request_access → pending grant → manager approval` was already a
proposal/approval engine. Pointed at _mutations_ instead of _access_, it becomes
the governed write path: **an agent may propose; only an authenticated human may
approve.**

Whether a write applies directly or becomes a proposal is a property of the
**grant**, not of the caller: `mode: direct | proposal_only`. An agent-driven
integration gets `proposal_only`; a trusted back-office tool gets `direct`.

A `proposal_only` write runs the _identical_ validation chain and then, instead
of promoting, stores the revision with `_rev_status = 'pending'` and
`_current = false`, returning `{ status: "pending", proposalId }`. Two properties
follow from the storage model rather than from code:

- Pending revisions never contend for the partial unique index, so **multiple
  proposals can coexist** against one document.
- **The proposed after-state is never readable through the view**, so unapproved
  agent output cannot leak into ordinary `query` or `search` results.

### Promotion is a merge, not a replace

Replacing the current row would make two agents editing _disjoint_ fields collide
spuriously. Instead, promoting a pending revision writes a new current revision
whose values are _current values, overwritten by the proposal's `_rev_fields`_.
Two disjoint proposals both apply cleanly, in approval order.

**Conflict is detected semantically.** A proposal carries `_rev_base`, the
`_rev_seq` it was derived from. At promotion, if any field in its `_rev_fields`
was also changed by an approved revision after `_rev_base`, it refuses with
`conflict`. Staleness alone is not a conflict — overlap is.

The merged revision records the **proposer** as `_rev_by`: that column is who
authored the content. Who approved it is in the audit row.

**The consumed proposal becomes `superseded`, not `approved`.** Because promotion
writes a _new_ row, the pending row it merged from is still there, and marking it
`approved` left two approved rows carrying the same `_rev_fields` and `_rev_by` —
so a document's history showed every approval twice, and the merged row's
`_rev_seq` (taken from `max(_rev_seq)`, which counted the pending row) skipped a
number each time. A document with three revisions reported sequence 1, 2, 3, 4, 5.

The pending row is now marked `superseded` and the merged row's sequence comes
from the revision it replaces, so the history is one entry per approval with a
contiguous sequence. `listRevisions` excludes superseded rows: they record what
was _proposed_, not a state the document ever held. They are kept rather than
deleted — the write role holds no `DELETE`, and once a merge has pulled in a
concurrent change the merged row no longer shows what was actually proposed.

A superseded proposal deliberately shares the `_rev_seq` of the revision that
consumed it: the sequence was assigned at proposal time as the slot it expected to
occupy, and unless a concurrent write intervened that is the slot it got.

`superseded` is a storage detail, not API vocabulary. A proposal's lifecycle is
pending → approved | rejected, so `listProposals({ status: "approved" })` matches
superseded rows. Querying the column directly for `approved` would return the
merged _revisions_ instead — and before the two were distinguished it matched both,
which is why that listing was doubled.

`broker.listProposals` returns metadata and the _names_ of the fields a proposal
touches — **never their values**. A reviewer fetches content through
`getDocument`, where postures are already enforced; duplicating values into the
listing would be a posture bypass. It reads through the write pool, the only role
with `SELECT` on base tables, because a pending revision is by definition not in
the view.

### Approval authorization

- `approve ∈ grant.verbs`, loaded fresh, so a revoked grant fails the very next
  call with no token wait.
- The proposal's document must pass the **approver's** document filter; failure
  is `not_found`, not a distinguishable refusal.
- **`approve` requires `read` coverage of every field in the proposal.** If any
  field in `_rev_fields` is outside the approver's `allowedFields`, the approval
  refuses `field_denied`. You cannot approve what you cannot see; without this,
  "approve, then read the diff" is a privilege-escalation path around field
  postures. This is enforced at approval time as well as at grant time.

> **`approve` and `reject` are deliberately not MCP tools.** The untrusted model
> may propose; it may never approve. Approval happens only through an
> authenticated human surface — the warehousd web UI, or the integrating app's
> own UI over REST.

## The change feed

Without a feed, every review UI polls the data. The revision history is already
an event log, so the feed is nearly free — but it is a **control-plane artifact
carrying no field data**, or it would become a posture bypass.

```sql
create table app.change_log (
  seq         bigserial primary key,   -- the cursor
  org_id      text not null, env text not null,
  collection  text not null, document_id text not null,
  rev         uuid not null, op text not null, status text not null,
  at          timestamptz not null default now(), by text not null);
```

`seq` is a **global** monotonic cursor; `_rev_seq` is per-document and cannot
serve as one, which is why this table exists rather than reading the revision
tables directly.

**Written in the same transaction as the revision.** If the revision rolls back,
the feed entry does too. That requires the write roles to hold `usage` on schema
`app` and `insert` on `app.change_log` — and nothing else there. Writing the feed
row on the app pool after commit was rejected: that is a second transaction, and
the feed would drift from the revisions on any crash between them. A test proves
it by revoking the feed insert and asserting the revision disappears with it.

**`seq` order is not commit order.** `bigserial` hands out numbers when a
statement runs, not when its transaction commits, so a writer can take `seq 7`
and commit after one holding `seq 8`. A reader polling in between would see 8,
advance past 7, and lose it. The feed therefore returns only rows whose inserting
transaction is older than the oldest still-running one
(`xmin < pg_snapshot_xmin(pg_current_snapshot())`). Once a row is returned, no
lower `seq` can appear afterwards. A fixed time delay was rejected: it is both
laggy and still wrong for any transaction outliving the delay.

`broker.changes(ctx, { since, limit })` returns entries for `(org, env)` with
`seq > since`, filtered to collections the caller holds a `read` grant on. A
caller with no grants gets an empty feed, not a refusal — the feed is not an
existence oracle for collections.

**A grant's document filter is not applied**, because the feed holds no field
data to test a predicate against. The consequence is deliberate and bounded: such
a caller learns that _some_ document in that collection changed, and its id, but
not which fields moved or what they hold. `getDocument` then refuses the ones
outside the filter. **A per-document ACL is not applied either**, for the same
reason and with the same consequence — see
[Per-document ACLs](#per-document-acls).

**Retention is deferred.** Revision history and the change log both grow without
bound on a writable collection. The eventual answer is a retention policy or
partitioning on `_rev_at` / `at`; until then an operator should plan for growth
rather than discover it.

The audit trail is the same problem with a sharper edge. `app.audit_events` also
grows without bound, and the application *cannot* prune it: `revoke update,
delete` is what stops a compromised app role erasing its own trail, and it stops
the app tidying up for exactly the same reason. Pruning is a superuser action,
and therefore a deliberate and attributable one. That is the intended trade —
unbounded growth is the price of a trail the application cannot rewrite.

For backups, the order that matters is: `app.grants`, `app.audit_events` and
`app.change_log` are irreplaceable; `data_synth` regenerates from the config with
a fixed seed (`warehousd regen-synth`); `data_live` has its own upstream and an
append-only import path. The mechanics are per target:
[deploy-fly.md](deploy-fly.md#backups),
[deploy-railway.md](deploy-railway.md#backups) and
[deploy-compose.md](deploy-compose.md#backups).

## Client credentials and the collection ceiling

IT issues a key/secret pair per company app. The key authenticates the **app**; a
subject token identifies the **user**. They compose:

```
effective access = grants(user) ∩ client_policy(app) ∩ env_scope(token)
```

This extends `app.client_policies` rather than introducing a parallel credential
system — a parallel system is precisely how the two sets of rules drift apart.

**Secret handling**, matching OpenAI/Anthropic/GitHub conventions:

- **Prefixed and self-identifying** — `whd_live_…` / `whd_dev_…` with a checksum
  suffix. A leaked key is greppable, its environment is visible on sight, and an
  obviously-malformed key is rejected before any database work.
- **The prefix is a ceiling, not only a label.** The environment is chosen once,
  when the key is minted, and `/v1/token` strikes `env:live` from the client
  policy for a `whd_dev_` key before resolving any scope
  (`narrowPolicyToKeyEnv`). So a dev key cannot reach real data however the
  policy is widened afterwards — which is what makes "its environment is visible
  on sight" worth anything during a leak. It only ever narrows: a `whd_live_` key
  still needs a policy allowing `env:live` **and** a user holding an approved,
  unexpired live grant. Rotation carries the environment forward; changing it
  means minting a new key.
- **Promoting a client whose keys cannot reach live is refused**, rather than
  recorded as a promotion that does nothing. `POST /api/oauth-clients/:id/promote`
  answers `409 no_live_capable_key` when the client holds usable keys and none
  is live-prefixed — otherwise `promoted_at` would be stamped and the console
  would show the client as live-capable while every key it has is capped at dev.
  A client with no API keys at all is unaffected: its environment comes from the
  authorize flow, not from a prefix. Demotion is never refused.
- **Shown once at creation**, never retrievable. Only a salted scrypt hash is
  stored, compared in constant time.
- **Rotation without downtime** — a client may hold two live secrets at once, and
  the old one is revoked _explicitly_. Revoking on rotation would make every
  rotation an outage. A third unrevoked secret is refused.
- **Mandatory expiry with a ceiling** (365 days). A never-expiring credential is
  philosophically opposite to purpose-bound expiring grants.
- `last_used_at`, `created_by`, `created_at` recorded per key.

**The collection ceiling.** `client_policies.allowed_collections` lets IT declare
_"the Marketing Dashboard may touch `campaigns` and `accounts`."_ Even if a user
personally holds a grant on `salaries`, that app cannot reach it as them. A
ceiling **only ever narrows** — it can never widen a grant.

It is carried on `BrokerContext` and enforced inside `loadActiveGrant`, which
takes the whole context rather than spread arguments precisely so that no verb
can forget it. A collection outside the ceiling returns null, so every verb
refuses `no_grant` uniformly: a distinguishable code would tell an app exactly
which collections it is missing.

`listCollections` is the exception that has to apply the ceiling itself, because
discovery answers before any grant is loaded. It intersects with the ceiling for
the same reason every other verb does: otherwise a restricted client can read
back the name and description of every collection in the config — a catalogue of
exactly what it is not allowed to ask about. Within the ceiling, names and
descriptions stay visible to any authenticated caller whether or not they hold a
grant; that is deliberate, and it is what makes `request_access` usable — you
cannot ask for access to a collection you cannot see exists.

**Audit `via`.** Every audit row records which credential produced it —
`session | oauth | token_exchange | api_key:<id>`. _"Which credential did this"_
is a compliance question the previous audit row could not answer.

### One implementation of the env rules

The §6.1 scope rules were inline in the OAuth plugin. They are now a pure broker
function, because **if a key can reach `env:live` by any path an OAuth token
cannot, invariant 5 is dead** — and two implementations is how that happens.

Issuance and refresh are deliberately _different questions_ and have separate
entry points:

- `resolveEnvScopes` answers **"what may this request have"** — intersect with
  the policy, drop `env:live` unless the user is eligible, and fall back to the
  `env:dev` floor. A caller that requested no env scope at all is left untouched.
- `recomputeEnvScope` answers **"what may this user have now"**, re-derived from
  current policy and eligibility. Refresh must not narrow from the scopes the
  token already holds: `env:live` was stripped at issuance, so an intersection
  could never widen it back after a promotion.

## Full-document reads

`broker.getDocument(ctx, { collection, id | path })` returns one document's full
granted field set, subject to **the same grant, read verb, field postures and
document filter as `query`** — it shares that prologue rather than duplicating
it, and builds its SQL through the same builder.

A document excluded by the document filter is `not_found`, indistinguishable
from one that does not exist: a distinct code would be an existence oracle.

`path` addresses a source file and is file-collections-only; on a dataset it is
`invalid_intent`. Because one file yields many documents, the file form fetches
every chunk in `document_seq` order and rejoins them, undoing the indexer's
overlap. That reconstructs the _chunked_ text, not the source file byte-for-byte
— chunking trims and rejoins paragraphs, and nothing stores the original body.
A caller needing the exact source must keep it.

## Per-document ACLs

A grant can scope to a _set_ of documents — `document_filter` is `eq`/`in`, ANDed
— but it cannot exempt an individual one: there is no `OR` and no negation in the
filter algebra, deliberately. A collection that declares `acl: true` gets a
second, orthogonal rule instead:

> A document with **no ACL** is readable by anyone the grant covers. A document
> **with an ACL** is readable only by the principals listed on it.

An ACL never widens a grant. It only takes one document out of one.

**Principals are namespaced** — `user:<userId>` and `group:<name>`. Without the
prefix a group named the same as a user id would grant that user's access, and an
ACL author would have no way to say which they meant. Validated on write.

**Group membership is warehousd's own fact.** It lives in `app.user_groups` and is
derived from `ctx.userId` on every call — never read from a token, a claim, or
anything a caller supplies. Invariant 1 says the broker is the trust boundary, and
a per-document deny that depends on an assertion minted outside it is not a deny;
this is the same reasoning `grants/eval.ts` gives for refusing to bake grants into
tokens. Membership arrives from an SSO login (`source: 'sso'`) or from the console
(`source: 'manual'`), and each source replaces only its own rows.

**Storage is one table per env data schema**, `data_synth."_acl"` /
`data_live."_acl"`, shared by every collection and keyed
`(org_id, collection, document_id)`. No row means public — which is the whole
design: 1,000 pages with one restricted page is one row, and the other 999 cost
nothing. It lives in the data schema rather than in `app` because the app pool has
no data-schema privileges and the read pools have none on `app`, so an
`app`-schema ACL could not be joined into a collection's view at all.

**The view carries it as a structural column.** `viewDDL` left-joins `_acl` and
exposes `acl.principals as "_acl"`, exactly the way it already exposes `tsv`,
`checksum` and `embedding`: it names no configured field, so no grant can carry it
and `buildSelect` can never project it — the select list is drawn from the YAML
field set. The name is reserved, so a collection cannot declare a field called
`_acl`. Org isolation follows the usual two walls: the join carries
`acl.org_id = base.org_id` explicitly, and `_acl` has the same RLS policy every
other data table has.

**The read path is one fixed clause**, emitted by the broker and never composed
from caller input:

```sql
coalesce(array_length("_acl", 1), 0) = 0 or "_acl" && $n::text[]
```

`$n` is the caller's principal set — a bound parameter like every other value
(invariant 2). It is pushed into the same `WHERE` every predicate goes into, which
is what puts it **inside** the hybrid `scoped` CTE and what makes an aggregate
honest: a `count` over an ACL'd collection counts what the caller may see, not
what exists and then a shortfall that reports the difference. The count that
motivated the feature — 1,000 documents, one restricted — returns 999 through MCP.

**The write path re-evaluates in process**, because it reads base tables for the
`_rev*` bookkeeping the view does not expose. There were eight `matchesFilters`
call sites; a separate ACL check beside each would have been eight chances to
forget one. They all go through a single `admits(row, grant, c)` in
`grants/filters.ts`, which checks the document filters **and** the ACL —
`matchesFilters` is module-private, so a caller holding the grant cannot skip
either half. Each of those queries left-joins the ACL onto the row it was already
fetching, in the same transaction, so there is no window between reading a
document and reading the policy that governs it. `admits` fails **closed** when the
column is absent: a null `_acl` is "no ACL row" and is public, but a missing one
means the query did not ask, and reading that as public would turn a forgotten
join into a silent leak. `test/acl-parity.test.ts` asserts the SQL and in-process
evaluators agree, the same way `filter-parity.test.ts` does one layer up.

**Editing an ACL is not a grant verb.** A grant says which documents and fields a
caller may read; widening who else may read something is a different act, and
letting it ride on `update` would mean any grant that can edit a page can also
unrestrict it. `getDocumentAcl` / `setDocumentAcl` are authorised against the
caller's standing instead — a console user with role `admin`/`manager`, or a
client whose policy carries `can_manage_acl` (default false) — and the broker
reads the role or the flag from the database itself, so an adapter cannot assert
an authority it does not hold. Both go through `makeAuditWriter` like every other
decision (invariant 7), and `app.audit_events.principals` records the membership
each decision ran under, because reproducing "who could read page 742 on the 4th"
needs membership as it *was*.

**There is no MCP tool for either.** An untrusted proposer must not be able to
widen access to anything.

Writes go through the write pool, which holds `select, insert, update, delete` on
`_acl`. That `delete` is a deliberate exception to the no-DELETE-on-data rule: an
ACL is not content, it has no revision model, and removing the row is the only way
to make a restricted document public again — a tombstone would force "no
principals" and "no row" to mean different things, and they do not.

Not in v1: **file collections** (an ACL keyed on `file_id` rather than a pk, a
second join in the file branch of `viewDDL`, and a decision about the indexer's
write path — config refuses `acl: true` there), **connect-in-place collections**
(warehousd does not own those rows), a **default-private** mode, **inheritance**
down a tree, and **deny entries**. Positive principals only.

## Semantic search

`{collection}__documents.embedding` is a `vector(N)` column, N from
`embedding.dimensions`, indexed with HNSW over `vector_cosine_ops`. HNSW rather
than IVFFlat because IVFFlat has to be built over existing rows to choose its
lists, and `applyConfig` creates the index on an empty table.

The broker declares `Embedder` (`packages/broker/src/providers.ts`) and consumes
it through `VerbDeps`; the implementations live in `@warehousd/providers` and are
injected by the adapter, exactly as `Pools` is. That is what keeps the broker
free of an ONNX runtime and of any outbound HTTP call — the purity the package
exists to have.

**The query vector is derived server-side from `q`, after the caller's grant has
been loaded.** There is no way to supply one: a client-supplied vector is an
oracle over the embedding space of documents the grant excludes, letting a caller
read similarity out of a corpus they cannot read.

`hybrid` is Reciprocal Rank Fusion over two CTEs, chosen over a weighted score
sum because `ts_rank_cd` and cosine similarity share no scale and RRF uses only
each list's *order*. Both CTEs read one `scoped` CTE, so the grant's predicates
are applied **before either ranking and before either LIMIT**. Ranking first and
filtering afterwards would leak: a caller asking for five would receive however
many of the global top five their grant allowed, and the shortfall itself reports
how many documents they cannot see.

## Connect-in-place collections

A collection with `source_ref` reads through a `postgres_fdw` foreign table that
lives inside `data_live`. Everything downstream is unchanged — same view, same
`grantViewDDL`, same `dataPool`, same `buildSelect` — because the foreign table
occupies the position a base table would. A second connection pool inside the
broker was the alternative, and would have needed a variant of `dataPool`,
`withOrg`, the RLS policy and the org predicate: four new ways to get tenant
isolation wrong.

Read-only is enforced by the database. The server and the foreign table are both
`updatable 'false'`, no role holds anything but `SELECT` on the wrapping view, and
`mutate` refuses `not_writable` structurally in front of that.

The column set is enumerated from the YAML, one `create foreign table` at a time,
rather than by `import foreign schema`. A column added upstream is therefore
absent from the local schema entirely — not merely ungranted — so no query,
broker-built or otherwise, can reach it. `applyConfig` verifies the remote matches
what was declared and fails at boot, in front of the operator, rather than letting
drift surface at request time as an `internal_error` nobody can diagnose.

**Tenant isolation is one wall here, not two.** Every other collection has both
the view's `org_id` predicate and an RLS policy on the base table. A foreign table
can carry neither: it has no `org_id` column, and RLS does not apply to it. The
view instead compares the request's org against the constant `org:` the source
declares. That is a real narrowing and is stated in
[SECURITY.md](../SECURITY.md) as well as here.

`dev` never touches the external system: an external collection gets an ordinary
generated table in `data_synth`, which is what keeps invariant 6 true.

## Taxonomies

A vocabulary is declared once under `taxonomies` and bound to a collection with
`taxonomies: [<slug>, ...]`. The bound field is a normal text field on the collection —
auto-added as `allow` if the YAML omits it — and terms are validated against the
vocabulary. A vocabulary may allow multiple terms per document with `multiple: true`;
grants scoped to multiple terms use Postgres array overlap (`&&`) semantics. A grant
scoped to `hr` compiles to a document filter over that field, so `finance` documents
are silently absent: the user never learns they exist. Vocabulary slugs may not
collide with the fixed file fields or the structural columns (`id`, `checksum`,
`file_id`, `document_seq`, `tsv`, `_rank`). Vocabularies may be dataset-sourced
(pulling terms from another collection) instead of inline; the ordering requirement
is that `syncDatasetTerms()` must run after data is loaded but before `indexCollection()`.

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
  allowed_collections text[],        -- the ceiling; null = none
  mode text not null default 'delegated',   -- delegated | headless
  robot_user_id text, trusted_issuer_id uuid,
  promoted_at timestamptz, promoted_by text
);

create table app.client_secrets (   -- only a hash; the secret is shown once, at creation
  id uuid pk, client_id text references client_policies, org_id text,
  prefix text, secret_hash text, created_at timestamptz, created_by text,
  expires_at timestamptz not null,  -- mandatory, capped at 365 days
  last_used_at timestamptz, revoked_at timestamptz
);

create table app.trusted_issuers (  -- registered IdPs for RFC 8693 token exchange
  id uuid pk, org_id text, issuer text, jwks_uri text,
  audience text, subject_claim text default 'sub', unique (org_id, issuer)
);

create table app.audit_events (
  id uuid pk, at timestamptz, user_id text, org_id text, env text, collection text,
  intent jsonb, fields_returned text[], unmasked_fields text[],
  principals text[] not null default '{}',  -- the membership the decision was made under
  grant_id uuid, outcome text, reason text
);

create table app.user_groups (         -- warehousd's own record of group membership
  org_id text references organizations, user_id text, group_name text,
  source text check (source in ('sso','manual')),
  updated_at timestamptz, primary key (org_id, user_id, group_name, source)
);

create table app.sso_provisioned (     -- (user, provider) pairs seen once; see lib/sso.ts
  user_id text, provider_id text, at timestamptz, primary key (user_id, provider_id)
);

create table app.change_log (          -- the change feed; carries no field data
  seq bigserial pk, org_id text, env text, collection text, document_id text,
  rev uuid, op text, status text, at timestamptz, by text
);

create table app.login_attempts (      -- credential lockout; keyed by email, not user id
  email text pk, failures int, last_failure_at timestamptz, locked_until timestamptz
);

create table app.schema_migrations (   -- the migration ledger; written by the runner itself
  version text pk, applied_at timestamptz
);
-- audit_events is INSERT-only for the app role: no UPDATE, no DELETE privilege.
```

**The `app` schema is versioned.** `packages/broker/src/db/migrations/` holds an
ordered, append-only list of SQL modules, and `migrateApp()` applies the ones a
database has not seen, recording each in `app.schema_migrations`. Two properties
make that safe to run on every boot, which the container entrypoint does — and
which the Fly release command depends on, since a failed migration there aborts
the deploy and leaves the previous release serving:

- **One advisory lock**, so a rolling deploy starting two instances at once
  cannot have both applying the same migration.
- **One transaction per migration**, so a failure rolls back and records nothing.
  A corrected migration is retried on the next boot rather than needing the
  database repaired by hand.

Migration `0001` is the pre-ledger schema verbatim, and every statement in it is
`if not exists` or a `pg_constraint`-guarded `add constraint`. That is what lets
an existing deployment adopt the ledger with no baseline step: it runs once
against a schema that already matches, changes nothing, and records the version.
Migrations after `0001` inherit none of that and must be forward-only. Never edit
one that has shipped — the ledger records versions, not contents, so an edited
migration is silently skipped everywhere it already ran.

`warehousd apply` owns everything in `data_synth` and `data_live` — tables and
views — separately and idempotently, diffing against `app.collections.config`.
Broker data queries and view DDL are raw SQL through `pg` with the two
role-scoped pools.

Collection DDL is **not** versioned, and that distinction matters. Re-applying
creates every table `if not exists` and follows every non-primary-key column —
plain field, bound vocabulary, file metadata — with `add column if not exists`.
Views are dropped and recreated rather than replaced, since `create or replace
view` can only append columns. So adding a field to an existing collection, or
binding a new vocabulary to it, lands on both the table and the view no matter
where in the YAML it goes. Changing a field's type, renaming it, or removing it
still does not: the old column stays as it was.

## The MCP surface

One OAuth-protected endpoint at `/mcp`, streamable HTTP.

| Tool                  | Behavior                                                              |
| --------------------- | --------------------------------------------------------------------- |
| `list_collections`    | Names and descriptions only — no schema, no counts.                   |
| `describe_collection` | Only the fields visible under the caller's grants.                    |
| `query_collection`    | Filters, ordering, limits, aggregation — re-validated, then executed. |
| `search_documents`    | Ranked full-text search over a file collection, grant-filtered.       |
| `request_access`      | Opens a pending grant request for a manager to approve.               |

Refusals return a reason code plus a request-access hint — never a denied value,
never SQL. Tool descriptions state the governance model plainly: the model
reading them is the first consumer of the security posture.

Absent from the table on purpose, alongside `approve`/`reject`: **there is no
tool for editing a document's ACL.** The model may propose a write and may ask
for access; it may not decide who else can read something. See
[Per-document ACLs](#per-document-acls).

Clients find the authorization server through the standard discovery documents
under `app/.well-known/`: `oauth-authorization-server` (RFC 8414) and
`oauth-protected-resource` (RFC 9728). A connector needs only the `/mcp` URL —
the rest is discovered.

## What the model is trusted with

Nothing. Two failure modes are handled separately.

**Its tool calls are untrusted proposals**, re-validated by the broker like any
other caller's. That is the whole architecture above.

**Its final text answer is untrusted output too**, and warehousd does not try to
police it. Observed in practice: asked for salary data with no grant, a model
ignored the `no_grant` tool result and produced a plausible table of invented
salaries, admitting they were fabricated only when challenged. Nothing the broker
enforces prevents that — no field was disclosed, no grant was bypassed, and the
audit log correctly records a refusal. The failure is entirely in the answer the
model composed on top of it.

warehousd therefore ships **no LLM-facing surface of its own**. It earlier
included a chat console with a fabrication heuristic — a system prompt forbidding
invented data, plus a server-side scan for tables or currency figures in turns
where no `query_collection` had returned `ok: true`. Both were removed. The
heuristic was a demo bench, its state was reconstructed from a client-supplied
conversation history and so was forgeable by the client it was meant to check,
and it put a live model API key behind an endpoint that every authenticated
member could reach. A governance layer should not be the thing that also holds
the model credential.

Grounding an answer is the adapter's problem, and any adapter that puts an LLM in
front of the broker needs its own defence. The broker gives it what it needs to
build one: `fieldsReturned` on every allowed result, and a reason code with no
data on every refusal.

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

The REST adapter (`/v1`) follows this pattern exactly. It derives context in
`lib/rest-context.ts` with `deriveRestContext()` — extracting the token scope
for env, looking up orgId from the user row, loading the client policy to
determine `via` (how the client authenticated), and applying the collection
ceiling — then translates HTTP requests into broker intents and returns reason
codes on refusal. See `apps/web/lib/rest-context.ts` and `apps/web/app/v1/`
for the reference implementation.

### The console is an adapter too

The admin console's data browser (`/admin/collections/{name}`, Data tab) is not a
privileged view onto the database. It posts to `/api/collections/{c}/query` and
`/api/collections/{c}/search`, which derive a `BrokerContext` from the session
(`lib/session.ts`, `deriveContext`) and call the same two verbs the MCP and REST
adapters call. So an admin browsing a collection sees exactly what their own
grants allow, no more, and each page of results writes one audit row naming the
fields it returned. A collection nobody has granted them answers `no_grant`, and
the console renders that as an empty state offering to request access rather than
as an error.

Those two routes are deliberately **not** role-gated. A role gate in front of them
would be a second, weaker access rule standing where the real one already is.

The console's inventory surfaces — document counts, the file list, term usage —
are a different thing and are admin-gated: they report *how much* is there, never
*what* is in it. They still go through the broker (`documents/inventory.ts`),
because invariant 1 admits no exception for counting, and the file list still
drops a `posture: deny` field such as `path` unless the caller's own grant names
it (invariant 4).

`broker.query` is read-only. Naming is deliberately kept open for an additive
`broker.mutate` with its own validation and audit; the audit outcome column is
not called `query_outcome` for that reason.
