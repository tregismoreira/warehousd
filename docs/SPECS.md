# warehousd — Governed MCP Data Platform (MVP Specification)

**Status:** Draft for handoff · **Audience:** Claude (design + implementation planning) · **Author:** Thiago
**Working name:** `warehousd` (subject to change)

> **For implementation:** This is a *design spec*, not an implementation plan. Before writing code, convert this spec into a task-by-task plan using the `writing-plans` skill (bite-sized TDD tasks). The Acceptance Tests in §10 are the definition of done.

---

## 1. Product overview

warehousd is a **lightweight, open-source, governed data platform that exposes company data to AI assistants over MCP** — securely, with deny-by-default permissions, purpose-bound grants, and a hard separation between development (synthetic data) and live (real data) environments.

One Docker container + one Postgres database. An IT admin should go from `docker compose up` to "Claude is safely querying our data" in under 15 minutes.

**Positioning:** Not an MCP gateway (we are the data layer, not a proxy over existing servers). Not a data lake migration (collections start as uploads/imports; connect-in-place is a later phase). Not an app builder (that is the future warehousd platform; this MVP is its foundation).

**Strategic role:** This is the first end-to-end product deliverable. It must be professionally structured, easy to extend, and demonstrably secure. The architecture must leave the door open for: headless-CMS-style usage, secure corporate database usage, and the future agent-driven app-building platform (manager-built apps registering as OAuth clients).

## 2. Non-goals (MVP)

These are explicitly **out of scope**. Do not build them, do not scaffold for them beyond what §5 requires:

- No app builder, no agentic build pipeline, no review-gate UI for apps
- No data masking/transform postures — fields are allow or deny, nothing in between
- No parameterized free-form SQL from clients — named views only
- No connect-in-place to external databases (collections live in our Postgres)
- No SCIM provisioning, no per-team cost caps, no compliance export formats
- No multi-tenancy (one deployment = one organization)
- No write operations through MCP (read + access-request only)
- No built-in natural-language query layer (the MCP client is the NL layer; see §5.1)
- No aggregate-only posture (aggregation is allowed only on row-readable fields; see §5.1)

## 3. Core domain model

| Concept | Definition |
|---|---|
| **Collection** | A named, schema'd dataset (e.g. `people`, `documents`, `salaries`, `metrics`). Backed by a Postgres table per environment. |
| **Document collection** | A collection with `type: document` (§5.6): a directory of files indexed into a fixed schema (`title`, `content`, `path`, `owner`, `updated_at`), chunked and full-text searchable via `broker.searchDocuments`. Same postures/grants/audit as any collection. |
| **Field posture** | Per-field `allow` or `deny`. Deny is the default for any field not explicitly allowed. |
| **Grant** | (user, collection, purpose, allowed-fields ⊆ collection allow-list, env, expires_at, optional row_filter). Grants are requested by users, approved by a manager/admin, and evaluated **at query time** (revocation is immediate — never baked into tokens). The optional `row_filter` (§5.6.4) is a grant-author-supplied predicate restricting which rows the grant reaches (e.g. specific documents by `path`). At most one active approved grant per (user, collection, env) — enforced by a partial unique index. |
| **Environment** | `dev` or `live`. Dev resolves to synthetic data; live resolves to real data. Encoded in the access token, resolved by the broker. |
| **Purpose** | Free-text + short label stated at grant request time (e.g. "onboarding prep"). Stored on the grant, stamped on every audit event. |
| **Role** | `admin` (IT: manages collections, postures, SSO config), `manager` (approves grants for their scope), `member` (requests grants, queries). |
| **Audit event** | Immutable record of every broker decision: who, token env, collection, fields requested, fields returned, grant id, purpose, allowed/refused, timestamp. |

## 4. Security invariants (non-negotiable)

Every invariant below must be enforced structurally (by architecture, not by convention) and covered by an acceptance test in §10.

1. **Broker-only data path.** No code path outside the broker library may read collection tables. The MCP adapter, admin UI, and any future adapter call the broker; nothing else touches `data_live.*` or `data_synth.*`. Enforce with Postgres roles: the app connects with a role that has no direct privileges on data schemas; the broker uses `SECURITY DEFINER` functions or a dedicated connection role.
2. **Deny by default.** A field with no explicit posture is denied. A user with no grant sees nothing — not schema, not row counts, nothing beyond the collection's existence in `list_collections` (name + description only).
3. **Client/LLM is untrusted.** Query intents from MCP are proposals. The broker re-validates every intent against the grant before constructing SQL. SQL is built server-side from **named views** + a whitelist of filter operators; no client-supplied SQL fragments ever.
4. **Denied means absent.** Denied fields are excluded at SQL construction (never selected), not filtered from results. A denied column value must be provably absent from every response payload, error message, and log line.
5. **Dev never touches real data.** A `dev` token cannot reach `data_live` under any query, error, or race. Synthetic data is generated **from the schema definition only** — never sampled, copied, or statistically derived from real rows. **Enforcement mechanism:** the broker holds two separate Postgres connection pools with two distinct roles — `warehousd_dev` (privileges on `data_synth` only, zero on `data_live`) and `warehousd_live` (privileges on `data_live` only). The pool is selected by the validated token's env claim. Even a bug in schema-name resolution cannot cross the wall: the database itself refuses.
6. **Env parity.** Dev and live enforce identical postures and grant logic. The only difference between environments is the source schema. A query that succeeds in dev succeeds in live with the identical response shape.
7. **Everything is audited.** Every broker call — allowed or refused — writes an audit event before the response is returned.

## 5. Architecture

**Style:** Modular monolith. One deployable (Next.js app), one Postgres. One hard internal boundary:

```
┌─────────────────────────────────────────────────┐
│ Next.js application                             │
│                                                 │
│  Adapters (thin, replaceable):                  │
│  ├── MCP server  (streamable HTTP, OAuth 2.1)   │
│  ├── Admin/Web UI (collections, grants, audit)  │
│  └── [future] REST API, CMS delivery, apps      │
│                    │                            │
│         ▼ all calls go through ▼                │
│  ┌───────────────────────────────────────────┐  │
│  │ BROKER (pure library, no HTTP/MCP deps)   │  │
│  │ (identity, grants, intent) → rows|refusal │  │
│  └───────────────────────────────────────────┘  │
│                    │                            │
│  Auth (Better Auth: sessions, SSO, OAuth       │
│        provider for MCP clients)                │
└─────────────────────────────────────────────────┘
                     │
        Postgres (single instance)
        ├── app        (users, collections meta,
        │               postures, grants, audit)
        ├── data_live  (real collection tables)
        └── data_synth (synthetic collection tables)
```

### 5.1 The broker (core library)

Location: `packages/broker` (or `src/lib/broker` if single package — implementer's choice, but it must have **zero imports** from HTTP, MCP, or UI code, and must be independently testable).

```ts
interface BrokerContext {
  userId: string;
  env: "dev" | "live";        // from token, never from request body
}

type QueryIntent = {
  collection: string;
  fields?: string[];           // omitted = "all fields I'm allowed"
  filters?: Filter[];          // { field, op: "eq"|"neq"|"gt"|"lt"|"gte"|"lte"|"like"|"in", value }
  orderBy?: { field: string; dir: "asc" | "desc" };
  limit?: number;              // hard-capped server-side (default 100, max 500)
  offset?: number;
  // Aggregation (MVP): enables "average salary for senior accountants over 5 years"-class
  // questions. Validated like everything else: fn.field and every groupBy field must be
  // covered by the caller's grant. When `aggregate` is present, `fields` must be omitted.
  aggregate?: { fn: "avg" | "sum" | "count" | "min" | "max"; field: string }[];
  groupBy?: string[];
};

type BrokerResult =
  | { ok: true;  rows: Record<string, unknown>[]; fieldsReturned: string[]; auditId: string }
  | { ok: false; reason: "no_grant" | "expired_grant" | "field_denied"
               | "unknown_collection" | "unknown_field" | "invalid_intent";
      auditId: string };       // reason codes only — never echo denied field values or SQL

// Public surface (complete for MVP):
broker.query(ctx, intent): Promise<BrokerResult>
broker.describeCollection(ctx, name): Promise<VisibleSchema | Refusal>  // grant-filtered fields only
broker.listCollections(ctx): Promise<{ name: string; description: string }[]>
broker.searchDocuments(ctx, intent): Promise<BrokerResult>  // document collections only — §5.6.3
```

Validation order inside `broker.query` (fail fast, audit every outcome):
intent shape → collection exists → active grant for (user, collection, env-appropriate) → every requested field ∈ grant.allowedFields → every filter/orderBy field ∈ grant.allowedFields → every aggregate.field and groupBy field ∈ grant.allowedFields → build SQL from the collection's named view in `data_{env}` selecting only granted fields (or aggregate expressions over them) → execute → audit → return.

**Aggregation policy (MVP):** aggregation is permitted only on fields the caller could already read row-by-row. This is deliberate: it means aggregates can never leak anything new, so no minimum-group-size or differential-privacy machinery is needed yet. An "aggregate-only" posture (compute `avg(base_salary)` without row access) is explicitly **post-MVP** — see §12 — because doing it safely requires inference-leak protection (an average over a group of one *is* the value).

**Natural language is deliberately absent from the broker.** In this architecture the MCP client (Claude) is the natural-language layer: it translates "what's the average salary for a senior accountant in the past 5 years" into a `QueryIntent`. Embedding our own NL→query model would duplicate that, place an untrusted LLM inside the trust boundary, and add an external API dependency to the offline container. The broker's job is to make the *structured* intent expressive enough (filters + aggregates + groupBy) that Claude can answer such questions.

### 5.2 Named views

For each collection and environment, a Postgres view `data_{env}.v_{collection}` defines the queryable surface. Views may pre-join (e.g. `v_people` joins `departments` for a `department_name` column) so the MCP surface stays flat. The broker only ever selects from views, never base tables.

### 5.3 Declarative configuration

The system state is defined in **`warehousd.yml` at the root of the consuming project** (the app that uses the data layer — e.g. Cortex — not inside warehousd's own repo). Applied idempotently by the CLI and on container start. Governance lives in git, in the app's repo.

**File resolution (serverless-framework style):**
- `warehousd.yml` — committed, the source of truth
- `warehousd.local.yml` — optional, gitignored, deep-merged over the base (personal overrides: ports, row counts, a real DB connection string)
- `${env:VAR_NAME}` interpolation anywhere in either file (secrets never live in YAML)

```yaml
project: cortex                    # namespace for containers/volumes/state
database:
  managed: true                    # CLI runs Postgres in Docker (default)
  # url: ${env:DATABASE_URL}       # alternative: bring your own Postgres
server:
  port: 8722
```

```yaml
collections:
  people:
    description: Employee directory
    fields:
      id:              { type: uuid,   posture: allow, pk: true }
      full_name:       { type: text,   posture: allow }
      email:           { type: text,   posture: allow }
      department_name: { type: text,   posture: allow, view_join: departments.name }
      home_address:    { type: text,   posture: deny }
  salaries:
    description: Compensation records (sensitive)
    fields:
      id:          { type: uuid,    posture: allow, pk: true }
      person_id:   { type: uuid,    posture: allow, fk: people.id }
      base_salary: { type: numeric, posture: deny }
      currency:    { type: text,    posture: allow }
synthetic:
  rows_per_collection: { people: 40, salaries: 40, documents: 25, metrics: 730 }
```

Note the two-level deny: a `posture: deny` in YAML means the field can never be granted (admin must change the file); fields with `posture: allow` are still deny-by-default per user until a grant covers them.

### 5.4 Synthetic data generation

Module: `packages/broker/synthetic` (part of core, part of the trust story).

- Input: the YAML schema only. **No read access to `data_live` — enforce with the Postgres role.**
- Deterministic with a seed (reproducible fixtures for tests).
- Type-aware generators: names/emails from wordlists, addresses with realistic shape, numerics within configured ranges, timestamps over configured windows, ~5% nulls on nullable fields.
- Referential integrity: FKs declared in YAML are honored (every `salaries.person_id` points to a generated person).
- Regenerable on demand from the admin UI (`Regenerate dev data` button).

### 5.5 Data model (app schema, abridged)

```sql
-- Better Auth manages: user, session, account, sso_provider, oauth_client tables
create table app.collections   (name text pk, description text, config jsonb, updated_at timestamptz);
create table app.grants (
  id uuid pk, user_id text refs user, collection text refs collections,
  purpose_label text, purpose_detail text,
  allowed_fields text[],                  -- ⊆ YAML allow-listed fields
  row_filter jsonb,                       -- optional grant-author predicate (§5.6.4); null = no row restriction
  env text check (env in ('dev','live')),
  status text check (status in ('pending','approved','denied','revoked')),
  requested_at timestamptz, decided_at timestamptz, decided_by text, expires_at timestamptz
);
-- at most one active approved grant per (user, collection, env) — required for row_filter safety (§5.6.4)
create unique index grants_one_active on app.grants (user_id, collection, env) where status = 'approved';
create table app.audit_events (
  id uuid pk, at timestamptz, user_id text, env text, collection text,
  intent jsonb, fields_returned text[], grant_id uuid, outcome text, reason text
);
-- audit_events: INSERT-only for the app role (no UPDATE/DELETE privileges)
```

### 5.6 Document collections & indexing

> Condensed from the full design: [`docs/superpowers/specs/2026-07-18-document-indexing-design.md`](./superpowers/specs/2026-07-18-document-indexing-design.md) — read that before implementing; it grounds every decision below in the existing code.

Documents (files in a directory, uploads later) become searchable by the LLM through the same broker/grant machinery as structured collections. Full-text search now; a `vector(1536)` embedding column is reserved (pgvector enabled) so semantic search is a later additive increment, keeping the offline core intact.

**5.6.1 Collection type.** `warehousd.yml` collections gain `type: structured | document` (default `structured`) and, for documents, a required `source` directory (**dev** content — see 5.6.2) plus an optional `source_live`. Document collections have a **fixed** grantable schema — `title`, `content`, `path`, `owner`, `updated_at` — the YAML `fields` block only sets postures on these (a Zod refinement rejects other names at config load; another forbids `__` in any collection name, reserved for document storage tables).

```yaml
collections:
  policies:
    type: document
    description: Company policy docs
    source: ./docs/policies
    fields:
      title:   { posture: allow }
      content: { posture: allow }
      path:    { posture: deny }   # gates rows via row_filter, never readable
```

**5.6.2 Storage & the chunk view.** Per env schema and per collection: a `{collection}__docs` table (one row per file; `path` unique = upsert key; `checksum` for idempotent re-index) and a `{collection}__chunks` table (paragraph-aware chunks ~500–1000 chars with overlap; generated `tsv tsvector` column + GIN index; reserved `embedding vector(1536)` column, pgvector enabled). Per-collection naming avoids colliding with the seeded structured collection named `documents` (§9) and mirrors the one-table-per-collection pattern. The queryable surface is — as for every collection — a view `v_{collection}` (one row per chunk, document metadata joined on). The env roles get `SELECT` on the view only, never base tables; this works because views execute with the view **owner's** privileges (the `app` owner role), exactly as structured collections already do. The view also exposes non-grantable structural columns (`tsv` for ranking, `chunk_index` for citation) that are never governed data.

The **indexer** (`packages/broker/src/indexing` + a CLI entry point) scans the env-appropriate source directory, extracts text (`.md`/`.txt` in this increment; `title` from first heading/filename, `owner` from frontmatter, `updated_at` from mtime), chunks, and upserts — skipping unchanged files by checksum and deleting rows for files removed from disk (full sync). It writes base tables via a dedicated write role (or the apply/owner role); the read roles `warehousd_dev`/`warehousd_live` must never gain base-table privileges. **Invariant 5 applies to documents:** the YAML `source` directory is dev content — committed sample/demo files, never real corporate documents. Live content is indexed only by an explicit action (`--env live` with `source_live` or `--source`); the CLI must never silently index one directory into both envs. The demo ships distinct per-env sample directories with distinct canary strings, keeping the env wall demonstrable.

**5.6.3 Search.** `broker.searchDocuments(ctx, { collection, q, fields?, limit?, offset? })` reuses `broker.query`'s validation pipeline (collection exists and is `type: document` → active grant → requested fields ⊆ grant) and the same SQL builder: a `q`-guarded branch adds `tsv @@ websearch_to_tsquery('english', $n)` to the WHERE clause and orders by `ts_rank_cd` (one param slot for `q`, reused in both). No `aggregate`/`groupBy` for document search. Result rows carry reserved `_rank` and `chunk_index` keys (never in `fieldsReturned`); only granted fields are selected — `tsv` and un-granted `path` never appear in any response. Type matrix: `searchDocuments` on a structured collection → `invalid_intent`; `broker.query` on a document collection works unchanged (the chunk view is a normal view — document *listing* for free); `describeCollection`/`listCollections` unchanged for both types.

**5.6.4 Row-level grant scoping (pulled forward from §12).** Grants carry an optional `row_filter` — `{ field, op: "eq" | "in", value }`, reusing the `Filter` shape — so an admin/manager can scope a grant to particular documents (`path in [...]`) or, generically, particular rows of any collection. Rules:

- `row_filter.field` is validated against the collection's **YAML field set**, not the user's `allowed_fields` — that's what lets a denied field like `path` gate rows without ever being readable. It is author-supplied at approval time, never client-supplied; client `QueryIntent.filters` stay restricted to `allowed_fields` as before.
- The predicate is ANDed server-side into the same parameterized `WHERE` machinery as client filters. An empty `in`-list compiles to constant-false (deny all), never a SQL error.
- Excluded rows are silently absent (invariant 4), not a distinguishable refusal.
- Safety requires the single-active-grant index (§5.5): otherwise a second, broader grant would silently override the restriction.

**5.6.5 Acceptance (gates the increment).** Full numbered list in the design doc §8 — headline assertions: ranked grant-filtered results; denied fields absent; row-filtered rows silently absent; row_filter bypass probes leak nothing; idempotent re-index; env-role view-only privilege holds for document tables; empty in-list denies all; second approved grant refused by the index; every search audited.

## 6. Authentication & SSO

**Decision: adopt [Better Auth], do not build authentication. Build only authorization (grants engine, §5).**

Requirements:

1. **SSO-ready from day one.** Enterprise will not adopt a new login. The auth layer must support **generic OIDC SSO** in the MVP (works with Okta, Entra ID/Azure AD, Google Workspace) via Better Auth's SSO plugin. SAML: include only if the same plugin provides it without extra work; otherwise defer. Admin configures the IdP in the admin UI (issuer URL, client id/secret) — no code change, no redeploy.
2. **Local credentials exist only as a fallback** for the seeded demo and initial admin bootstrap. When an SSO provider is configured, login defaults to SSO; a `SANDBOXD_DISABLE_LOCAL_LOGIN=true` env var turns local login off entirely.
3. **JIT provisioning.** First SSO login creates the user with role `member`. Admin promotes roles in the UI. (IdP group→role mapping is a documented future item, not MVP.)
4. **warehousd is an OAuth 2.1 provider** (Better Auth OIDC-provider/MCP plugin) so MCP clients — Claude first — connect via the standard MCP OAuth flow. Critically, when the user authorizes an MCP client, the login step **delegates to the configured SSO IdP**. Net effect: connecting Claude to warehousd is "log in with your company account," never a new password.
5. **Environment selection is standard OAuth scopes — nothing invented.** Two scopes exist: `env:dev` and `env:live`. Env is **never** a request parameter to the broker or MCP tools; it exists only as a scope in the signed access token, decided server-side at issuance. See §6.1 for the exact flow.
6. **Tokens carry no grant data** — only subject (user id), client id, and the env scope. The broker loads grants fresh per request (invariant: revocation is immediate).

### 6.1 Environment selection: env-as-scope (exact flow)

**Data model addition** (managed alongside Better Auth's `oauth_client` table):

```sql
create table app.client_policies (
  client_id text pk references oauth_client,
  display_name text,
  allowed_scopes text[] not null default '{env:dev}',  -- server-side allow-list
  promoted_at timestamptz, promoted_by text            -- audit trail for live promotion
);
```

**Rules the authorization server enforces at token issuance** (implement as a hook in the OAuth provider's scope-granting step):

1. Requested scopes are intersected with `client_policies.allowed_scopes`. A client whose policy lacks `env:live` can request anything it wants — it will only ever receive `env:dev`. This is the tamper-proofing: escalation is impossible by construction, not by validation.
2. `env:live` is additionally intersected with the *user's* eligibility: the authenticated user must have ≥1 grant with `status='approved' AND env='live' AND expires_at > now()`. No approved live grant → `env:live` silently dropped from the issued scopes even for a live-allowed client.
3. If both `env:dev` and `env:live` survive, the consent screen shows an env picker (radio, default `dev`). Exactly one env scope ends up in the token — never both.
4. Tokens are short-lived (15 min) with refresh tokens; scope rules re-run on every refresh, so a revoked promotion or expired grant takes effect within minutes without waiting for logout.

**Client registration paths:**

- **First-party MCP client (Claude):** dynamic client registration (RFC 7591) is enabled — Claude's connector flow registers itself. Dynamically registered clients get the default policy: `allowed_scopes = {env:dev, env:live}` *(the per-user grant check in rule 2 is the real gate for humans in chat; their manager already approved their live grants individually)*.
- **User-built apps (e.g. a reporting app built with Claude Code):** created manually in Admin → Clients → "New client". Returns client id + secret. Default policy: `allowed_scopes = {env:dev}` — **always**, no override at creation time. The app is developed entirely against synthetic data by construction.
- **Promotion to live:** a `manager` or `admin` opens the client in the admin UI and enables `env:live` (sets `promoted_at`/`promoted_by`). No app change, no new credentials — the next token refresh can carry `env:live`, and the broker resolves against `data_live`, still filtered through the calling user's personal grants. Deployment approval is literally one flag.
- Admin UI must show per-client: allowed scopes, promotion audit trail, last token issued, and a "demote to dev" action (removes `env:live`; takes effect on next refresh per rule 4).

**BrokerContext derivation (the only way env enters the broker):**

```ts
// adapter code (MCP route / UI route) — the ONLY place BrokerContext is constructed
const token = await auth.verifyAccessToken(req);          // signature + expiry checked here
const env = token.scopes.includes("env:live") ? "live" : "dev";
const ctx: BrokerContext = { userId: token.sub, env };
// Any env-like value in the request body/params is ignored and never read.
```

## 7. MCP surface

One MCP server endpoint (`/mcp`, streamable HTTP), OAuth-protected. Tools (complete list for MVP):

| Tool | Behavior |
|---|---|
| `list_collections` | Names + descriptions of all collections. No schema, no counts. |
| `describe_collection(name)` | Schema of fields **visible under the caller's grants** in the token env. No grant → refusal with `request_access` hint. |
| `query_collection(intent)` | Passes `QueryIntent` to the broker. Returns rows or a reason code. |
| `search_documents(collection, q)` | Full-text search over a `type: document` collection via `broker.searchDocuments` (§5.6.3). Ranked chunks, grant-filtered fields, reserved `_rank`/`chunk_index` keys. |
| `request_access(collection, purpose, fields?)` | Creates a `pending` grant request; returns request id. Manager approves in the web UI. |

Tool descriptions must state the governance model plainly (deny-by-default, purpose-bound) — the model reading them is the first consumer of the security posture.

## 8. Admin / Web UI

Minimal, professional, three role-scoped surfaces (this is also the demo stage — apply the `frontend-design` skill during implementation):

- **Admin:** collections & postures (read-only view of YAML state + apply status), SSO configuration, user roles, regenerate synthetic data, audit log browser (filter by user/collection/outcome).
- **Manager:** grant request inbox → approve (set expiry, trim requested fields) / deny. Active grants list with revoke.
- **Member:** my grants + statuses, how-to-connect page (MCP endpoint URL + copy-paste Claude connector setup).

## 9. Seed data — "Meridian Robotics" (first-run experience)

Shipping demo = fictional company loaded on first boot (skippable via env var). It doubles as the acceptance-test fixture and the demo script.

**Personas** (local credentials, shown on the login screen in demo mode):

| Persona | Role | Purpose in demo |
|---|---|---|
| `ana@meridian.demo` | admin | IT view: postures, audit, SSO config |
| `marcus@meridian.demo` | manager | Has one **pending grant request waiting** on first login |
| `priya@meridian.demo` | member | Has approved dev grants for `documents` + `people`; her pending request for `salaries` is the one in Marcus's inbox |

**Collections** (graded complexity):

1. `documents` — simple flat collection (title, category, summary, owner, updated_at). All fields allowed.
2. `people` + `departments` — relational pair, exposed flat via `v_people`. `home_address` and `phone` are YAML-denied.
3. `salaries` — the sensitive one, seeded as a **5-year compensation history** (person_id, job_title, base_salary, currency, effective_date) with multiple records per person and realistic titles (including "Senior Accountant"), so the flagship demo question — *"what's the average salary we've been paying for a senior accountant in the past 5 years?"* — works end-to-end in Claude via filters + `avg` + `groupBy`. Postures: `base_salary` is `posture: allow` in YAML but ships with **no approved grants**, so the demo can show the leak probe failing, a manager granting access, and revocation cutting it live; an `ssn`-style field is YAML-denied to show the hard tier that can never be granted.
4. `metrics` — daily time-series, 2 years (date, revenue, active_customers, region) — shows realistic volume + filter/orderBy/limit behavior.

Both `data_synth` (always) and `data_live` (demo mode only, clearly fake but distinct values) are seeded so env separation is *demonstrable*: the same query returns different rows per env, and the dev token provably cannot see the "live" rows.

## 10. Acceptance tests (definition of done)

Automated (integration level, run in CI) unless marked manual.

1. **Broker-only path:** the app's Postgres role cannot `SELECT` from `data_live.*` / `data_synth.*` directly (test asserts permission error); the same query through the broker succeeds.
2. **Deny by default:** a fresh user with zero grants gets `no_grant` from `query_collection` and `describe_collection` on every collection; `list_collections` still returns names + descriptions only.
3. **Field-level enforcement:** with a grant for `people` excluding `email`, a query requesting `email` returns `field_denied`; a query without explicit fields returns rows where the `email` key is **absent** (not null) from every row object.
4. **Adversarial leak probe:** a scripted set of hostile intents (denied fields in `filters`, `orderBy`, `in`-lists; oversized limits; unknown-field probing; SQL fragments inside string values; intent-shape fuzzing) — assert zero occurrences of any denied value in response bodies, error messages, and application logs. Denied canary values are planted in seed data and grepped for.
5. **Dev/live wall:** with a `dev` token, exhaustive queries across all collections return only `data_synth` rows (assert on planted live-only canary values: zero hits). Attempting to mint a `live` token without an approved live grant fails. **Scope escalation:** a dev-only client requesting `scope=env:live` receives a token containing only `env:dev` (assert on the issued token's scopes); after admin promotion of the same client, the next refresh yields `env:live`; after demotion, the next refresh drops it. A token with `env` absent from scopes defaults to `dev` in the adapter. Direct DB check: role `warehousd_dev` gets a permission error on `select * from data_live.v_people`.
6. **Env parity:** the same intent under a dev grant and an equivalent live grant returns identical response *shapes* (same keys, same types) with different data.
7. **Grant lifecycle:** request → pending → approve (with trimmed fields + expiry) → query succeeds → revoke → *immediately next* query returns `no_grant` (no token refresh involved). Expired grants behave as revoked.
8. **Synthetic isolation:** the synthetic generator's DB role has no privileges on `data_live`; generation with a fixed seed is reproducible; FK integrity holds across generated collections.
9. **Audit completeness:** every test above increments `audit_events` with correct outcome codes; audit role cannot UPDATE/DELETE.
10. **Aggregation enforcement:** with a grant on `salaries` including `base_salary`, `aggregate: [{fn: avg, field: base_salary}]` with `groupBy` + date filters returns correct values against the seeded fixture. With a grant **excluding** `base_salary`, the same intent returns `field_denied` — asserted for the field appearing in `aggregate`, in `groupBy`, and in `filters`. An intent combining `aggregate` with `fields` returns `invalid_intent`.
11. **(Manual) MCP + SSO end-to-end:** configure a test OIDC IdP → connect Claude via the MCP connector → OAuth flow lands on the IdP login → after consent, `list_collections` works and a denied-field probe from the Claude conversation fails cleanly. Documented as a runbook with screenshots.
12. **LLM final-answer fabrication guard (Phase 0 chat route):** a scripted conversation where the model is asked for data on a collection it has no grant for, then pressed with a follow-up ("yes, show me more detail") after receiving the refusal — assert the second turn's response never presents numbers/rows as if a query succeeded when `queriedOk` is empty for that collection; the corrective re-prompt path is exercised and the final delivered message states the access is denied rather than fabricated data.
13. **(Manual) Cloud deploy end-to-end:** from the `examples/meridian` project, `warehousd deploy` to Fly.io succeeds only after the production checklist passes (verify it refuses first with demo mode on); the deployed `mcpUrl` connects from Claude over HTTPS; `data_live` on the deployed instance is empty; re-running `deploy` after a YAML posture change applies the diff. Documented as a runbook.

14. **Document indexing & search:** the full acceptance list in the [document-indexing design doc](./superpowers/specs/2026-07-18-document-indexing-design.md) §8 (ranked search, field/row denial, row_filter bypass probes, idempotent re-index, view-only privilege, empty in-list deny-all, single-active-grant constraint, audit) runs in CI alongside tests 1–10.

**Stub-vs-real documentation requirement:** the README must contain a table of every component marked `real` / `simplified` / `stubbed` for the MVP (e.g. "filter operators: real; SAML: stubbed; connect-in-place: absent").

## 11. Distribution, repository & deployment

**Distribution model (Supabase-CLI pattern — this is how devs consume warehousd):** the warehousd repo publishes two artifacts — a **Docker image** of the server (`ghcr.io/<org>/warehousd`) and an **npm CLI** (`warehousd`, runnable via `npx warehousd`). A dev integrating warehousd into their own project (e.g. Cortex) never clones this repo and never runs an install script. They add `warehousd.yml` to their app repo and use the CLI:

| Command | Behavior |
|---|---|
| `warehousd init` | Scaffolds a starter `warehousd.yml` (with the Meridian demo collections commented as examples) + `.gitignore` entries (`warehousd.local.yml`, `.warehousd/`). |
| `warehousd start` | Reads config → pulls/starts the server image + Postgres (unless `database.url` given) under the project namespace → runs `apply` + synthetic seed → prints the outputs block and writes `.warehousd/outputs.json`. Idempotent; re-running picks up YAML changes. |
| `warehousd stop` | Stops containers, keeps volumes. `warehousd stop --destroy` removes volumes. |
| `warehousd status` | Health + the outputs block again. |
| `warehousd apply` | Re-applies YAML (collections/postures/views) to a running stack without restart. |
| `warehousd seed` / `warehousd regen-synth` | Demo fixture load / regenerate synthetic data. |
| `warehousd deploy` | Provisions the stack to a cloud target from the same `warehousd.yml`. **MVP scope: one target, Fly.io.** See "Deploy" below. |

**Outputs contract** — printed on `start` and written to `.warehousd/outputs.json` so the host app can integrate programmatically (read it in `next.config`/startup, or copy into `.env`):

```json
{
  "mcpUrl": "http://localhost:8722/mcp",
  "apiUrl": "http://localhost:8722",
  "adminUrl": "http://localhost:8722/admin",
  "databaseUrl": "postgres://warehousd:...@localhost:8723/warehousd",
  "env": "dev",
  "devClient": { "clientId": "...", "clientSecret": "..." }
}
```

`devClient` is an auto-created OAuth client with `allowed_scopes = {env:dev}` (per §6.1) so the host app can obtain dev tokens immediately — the local DX and the production security model are the same machinery. `.warehousd/` is gitignored state (like `.serverless/`).

**Deploy (`warehousd deploy` — MVP, single target):**

To keep this shippable, MVP supports exactly **one provider: Fly.io**, driven by shelling out to `flyctl` (the user must have it installed and authenticated; the CLI checks and errors with install instructions otherwise). Multi-provider and a Pulumi/Terraform provider are post-MVP.

```yaml
deploy:
  target: fly
  app_name: cortex-warehousd        # fly app name (must be globally unique)
  region: gru
  database:
    managed: true                  # provision Fly Postgres in the same region
    # url: ${env:PROD_DATABASE_URL}  # alternative: bring your own Postgres
```

Behavior of `warehousd deploy`:
1. **Pre-flight production checklist — deploy refuses to proceed unless all pass:** an SSO provider is configured *or* `--allow-local-login` is explicitly passed; `SANDBOXD_DISABLE_DEMO=true` (no demo personas, no seeded `data_live`); all `${env:...}` references resolve.
2. Creates/updates the Fly app running the published server image, provisions Postgres per config, sets secrets from resolved `${env:...}` values via `fly secrets set` (never written to disk), and attaches the database.
3. Runs `apply` and synthetic seed against the deployed instance (`data_synth` only — **deploy never writes `data_live`**; real data arrives via the admin import path).
4. Writes the same **outputs contract** to `.warehousd/outputs.deploy.json` with public HTTPS URLs (Fly provides TLS): `mcpUrl` is now the address to paste into Claude's connector settings.
5. Idempotent: re-running deploys the current YAML state (a config diff is printed before applying; `--yes` skips the prompt).

`warehousd deploy --destroy` tears the app down after a typed confirmation of the app name (it may hold real data).

**Repo layout:**

```
warehousd/
├── apps/web/            # Next.js: UI + MCP adapter + auth routes → published as the Docker image
├── packages/broker/     # pure core: broker, grants eval, synthetic gen, yaml loader
├── packages/cli/        # the published `warehousd` npm CLI (init/start/stop/status/apply/seed)
├── examples/meridian/   # a consuming-app example: warehousd.yml + demo runbook
├── docker-compose.yml   # contributor/dev golden path for working on warehousd itself
└── docs/                # runbooks: connect-claude.md, configure-sso.md, threat-model.md
```

- **Stack:** Next.js (App Router) + TypeScript, Postgres 16, Better Auth, MCP TypeScript SDK, Drizzle for `app` schema; raw SQL for view creation and broker queries. CLI: plain Node + `commander`, talks to Docker via the `dockerode` API (or shells out to `docker` — implementer's choice, but detect-and-error clearly if Docker isn't running).
- **Two personas, two paths:** contributors to warehousd use the repo + `docker compose up`; consumers use `npx warehousd start` / `warehousd deploy` in their own repo. Phase 0 (§13) is contributor-path only; the CLI lifecycle commands **including deploy** are MVP deliverables, validated by running the `examples/meridian` project end-to-end locally and on Fly.io.
- **Offline guarantee:** after images are pulled, `warehousd start` works with no network (synthetic gen uses wordlists, not an LLM). (`deploy` obviously requires network.)
- **License:** MIT for the MVP (adoption > protection at this stage; revisit before any hosted offering).
- **Open-core note:** everything in this spec is OSS core. The future paid line (approval workflows at scale, SCIM, compliance exports) is documented in `docs/roadmap.md` only.

## 12. Roadmap pointers (context for design, not for building)

**Future adapter compatibility (design constraint, costs nothing now):** other products (e.g. a content/knowledge UI serving pages and paragraphs) will mount as additional adapters over the same broker, exactly like the MCP server. Two things the MVP must not preclude: (a) **row-level grant scoping** — ~~a future item~~ **pulled into scope by document indexing (§5.6.4)**: the `row_filter jsonb` column and broker validation now ship with that increment; (b) **a write path** — `broker.query` stays read-only, but name things so a future `broker.mutate(ctx, mutation)` is additive (e.g. don't call the audit outcome column `query_outcome`). Content-ish field types (`text` covers markdown bodies; a `json` type in the YAML schema is allowed in MVP) mean pages/paragraphs are representable as collections today.

Phase 2+: connect-in-place collections (views over external Postgres) · masking postures · **semantic/vector search** (populate the reserved `embedding` column per §5.6, add similarity ranking — needs an embedding model, so it stays out of the offline core) · document **upload UI** + PDF/DOCX extraction (§5.6 indexes local directories, `.md`/`.txt` only) · **write path** (`broker.mutate` with its own validation + audit — required for content-hub adapters) · **aggregate-only posture** (compute statistics over fields without row-level access — requires minimum-group-size / inference-leak protection before it is safe) · **NL search in the web UI** (an optional adapter that calls an LLM to produce a `QueryIntent`, then routes it through the same broker — for users not on an MCP client; adds an external API dependency, so it stays out of the offline core) · app platform (OAuth clients per manager-built app → restores app-scoped, purpose-bound access as the flagship differentiator) · IdP group→role mapping · **additional deploy targets** (Railway, generic Docker host, Pulumi/Terraform provider for infra-as-code shops — MVP ships Fly.io only) · hosted control plane.

## 13. Phase 0 — POC (build this first)

A pre-MVP proof that validates the entire enforcement core with a chat interface, **skipping authentication entirely**. Authorization only. Everything in this phase except the two throwaway pieces marked below is production code that the MVP keeps.

**Scope — build for real (kept in MVP):**
- `packages/broker` complete per §5.1: query validation, aggregates, named views, dual Postgres roles (`warehousd_dev` / `warehousd_live`), audit events
- YAML loader + `warehousd apply` (collections, postures, views)
- Synthetic data generator per §5.4
- Meridian Robotics seed per §9 (both `data_synth` and `data_live`, canary values planted)

**Post-POC increment (Phase 0.5 in the roadmap):** document indexing per §5.6 — collection `type: document`, indexer, `broker.searchDocuments`, row-level grant scoping — all production code kept in MVP, built against the POC's persona-switched console (the `search_documents` chat tool becomes the MCP tool in the MVP phase).

**Scope — throwaway (mark clearly in code as `// POC-ONLY, replaced by OAuth in MVP`):**
- **Persona switcher adapter:** instead of token verification, a dropdown in the UI selects the acting user (Ana / Marcus / Priya) and an env toggle selects dev/live. The adapter constructs `BrokerContext` directly from these two controls. This stub is the *only* code replaced when real auth arrives — the broker never knows the difference.
- **Chat page** (single screen, three panes):
  1. **Chat:** messages go to a Next.js server route calling the Anthropic API (`claude-sonnet-4-6`) with tool definitions mirroring §7 (`list_collections`, `describe_collection`, `query_collection` — no `request_access`; grants are managed in pane 3). Tool calls are executed against the broker with the current persona's context. Max 5 tool iterations per turn. The LLM remains an untrusted proposer: its tool inputs are `QueryIntent`s that the broker re-validates like any other caller.

     **The LLM's final text answer is also untrusted output, not just its tool calls.** Observed in practice: asked for salary data with no grant, the model ignored the `no_grant` tool_result and fabricated a plausible-looking table of salaries in prose, only admitting the numbers were invented when challenged on a follow-up turn. The chat route defends against this with two layers (see `docs/threat-model.md` § LLM Final-Answer Trust for detail):
     - **Prompt-level:** `SYSTEM_PROMPT` explicitly instructs the model to never fabricate, guess, or simulate data absent from a `tool_result`, and to state plainly when it hasn't successfully queried something, even under repeated user pressure.
     - **Code-level guard:** the route scans the full conversation (across turns) for `query_collection` tool_results with `ok:true` to build the set of collections actually queried successfully. If the model's final text contains a markdown table or multiple `$`-figures while that set is empty, the server injects a corrective message forcing the model to re-answer honestly instead of streaming the fabrication to the user. This is a heuristic, not a full grounding check — it targets the observed failure mode cheaply, without verifying displayed numbers match queried rows field-for-field.
  2. **Evidence panel:** live audit trail (auto-refresh after each turn) showing every broker decision — user, env, intent, outcome, fields returned. This is the "prove it's secure" surface.
  3. **Grants panel:** the acting persona's grants; when acting as Marcus (manager), pending requests can be approved/denied/revoked inline (writes `app.grants` directly — no workflow UI). Priya's pending `salaries` request from §9 is the demo arc: probe fails → Marcus approves → same question succeeds → revoke → fails again, all visible in the evidence panel.

**Not in Phase 0:** Better Auth, SSO, OAuth provider, MCP endpoint, admin UI, client registration. §6 is untouched until MVP.

**Acceptance subset (gates Phase 0):** tests 1, 2, 3, 4, 7, 8, 9, 10, 12 from §10 run as-is (1–4/7–10 hit the broker directly, no auth involved; 12 is scripted against the Phase 0 chat route itself). Test 5 runs partially: synth/live canary assertions + the direct DB role check; scope-escalation assertions are deferred to MVP. Tests 6 and 11 are MVP-only.

**Hard rule:** Phase 0 must never be deployed to a public URL (it has no authentication). `docker compose up` binds to localhost; the README says so in bold.

## 14. Implementation decisions (removing ambiguity for the executor)

- **Monorepo from day one:** pnpm workspaces — `apps/web`, `packages/broker`, `packages/cli`. Node 22 LTS, TypeScript strict.
- **ORM decision: Drizzle** (not Prisma) for the `app` schema — lighter, SQL-first, fits the raw-SQL broker style. Broker data queries and view DDL are raw SQL via `pg` (node-postgres) with the two role-scoped pools.
- **Migrations:** Drizzle Kit for `app` schema; `warehousd apply` owns everything in `data_synth` / `data_live` (tables + views), idempotently, diffing against `app.collections.config`.
- **Testing:** Vitest; integration tests run against a disposable Postgres via `docker compose -f docker-compose.test.yml`. The adversarial probe (test 4) is a data-driven test file (`probes.json`) so new hostile intents are added without code changes.
- **Anthropic API key:** `ANTHROPIC_API_KEY` env var, used *only* by the Phase 0 chat route (and later the optional NL adapter). The broker package must not import the Anthropic SDK — enforce with an ESLint `no-restricted-imports` rule on `packages/broker`.
- **For Claude Design:** the Phase 0 screen is the demo stage — apply the `frontend-design` skill; aim for a calm, credible "security console" aesthetic (evidence panel prominent, monospace for intents/audit rows, clear allow/deny color semantics beyond red/green alone). One screen, no navigation.


---

*Handoff checklist: (1) build Phase 0 (§13) first — writing-plans skill converts §5, §9, §13, §14 into a TDD implementation plan, executed via subagent-driven development, gated by the §13 acceptance subset; (2) Claude Design pass on the Phase 0 screen (frontend-design skill); (3) MVP phase adds §6 auth/SSO, §7 MCP endpoint, §8 UI, gated by full §10.*