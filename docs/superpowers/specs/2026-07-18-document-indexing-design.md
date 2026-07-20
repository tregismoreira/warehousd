# Document Indexing — Design Spec

**Status:** Draft for handoff · **Audience:** Claude (implementation planning) · **Author:** Thiago
**Scope:** Extends the Phase 0 POC (see `docs/SPECS.md` §13). This is an addition to the existing spec, not a replacement — all invariants in `docs/SPECS.md` §4 (broker-only path, deny by default, denied means absent, dev/live wall, everything audited) apply unchanged to documents.

> **For implementation:** This is a *design spec*, not an implementation plan. Convert to a task-by-task TDD plan with the `writing-plans` skill before writing code.

---

## 1. Goal

Let an admin index a directory of documents so their content becomes searchable by the LLM through the same broker/grant machinery that governs structured collections — with the same security guarantees (deny-by-default, grant-scoped, audited, dev/live separated).

## 2. Non-goals (this increment)

- No embeddings / vector similarity ranking yet — full-text search only. A `vector` column is reserved so this is additive later, not a migration.
- No file watcher / background indexing worker — a manual CLI script only.
- No PDF/DOCX extraction yet — `.md` / `.txt` only. Note as a fast-follow, not a blocker.
- No UI for uploading files in this increment — the indexer reads from a local directory (`source` in YAML). Upload UI is future work per `docs/SPECS.md` §1 positioning ("collections start as uploads/imports").

## 3. New collection type: `document`

**Implementation note:** `poc/packages/broker/src/config/schema.ts`'s `CollectionSchema` has only `{ description, fields }` today — every collection is assumed structured. This increment adds three optional fields to `CollectionSchema`: `type?: "structured" | "document"` (default `"structured"`), `source?: string` (the **dev** content directory — required when `type === "document"`, enforce with a Zod refinement; see §5 for the dev/live content policy), and `source_live?: string` (optional live content directory; live indexing can alternatively pass `--source` on the CLI). Two more refinements: collection names must not contain `__` (reserved for the `{collection}__docs`/`__chunks` storage tables, §4), and document-collection `fields` keys must be a subset of the fixed set. Additive to the shared schema, not just YAML authoring. `FieldSchema` is unchanged: document collections reuse it, just constrained to the five fixed field names.

`warehousd.yml` gains a `type: document` collection kind alongside today's structured (`type` implicitly relational) collections:

```yaml
collections:
  policies:
    type: document
    description: Company policy docs
    source: ./docs/policies       # directory scanned by the indexer
    fields:
      title:   { posture: allow }
      content: { posture: allow }
      path:    { posture: deny }  # internal identifier, never returned raw
```

Unlike structured collections, the field schema is **fixed**, not user-defined: `title`, `content`, `path`, `owner`, `updated_at`. The YAML `fields` block only sets postures on these fixed fields — it does not define new ones. A Zod refinement on `CollectionSchema` rejects any document collection whose `fields` keys aren't a subset of this fixed set (a typo like `titl:` fails at config load, not silently at query time). Postures and grants work exactly as they do for structured collections: `content: deny` means chunk text never leaves the broker for anyone.

**Grantable fields vs. structural columns.** The five fixed fields above are the *grantable* set — what `fieldsOf()` (`Object.keys(c.fields)`) returns, what grants cover, what can be selected/returned. The chunk view (§4.1) additionally exposes structural columns the search machinery needs but which are **not** grantable and **never** returned as data: `tsv` (ranking input only) and `chunk_index` (ordering/citation). If the LLM needs to cite *which* chunk of a document a passage came from, `chunk_index` is surfaced as a reserved, always-present result key (like `_rank`, §6) rather than a grantable field — it's structural metadata, not governed content. `chunk_id`/`document_id` stay internal (not returned) unless a later increment needs them. This keeps the grant/posture surface exactly the five semantic fields while giving search the columns it structurally requires.

## 4. Storage

**Environment→schema mapping (matches the implemented code):** dev resolves to the `data_synth` schema, live to `data_live` — see `db/pools.ts` and `sql/build.ts` (`env === "dev" ? "data_synth" : "data_live"`). Below, `data_{env}` means `data_synth` for dev and `data_live` for live. The two tables live in each of these schemas, mirroring the dual-role isolation used everywhere else (`docs/SPECS.md` §4.5, §5.4):

**Naming — avoid a real collision.** The tables are **per document collection**, named `{collection}__docs` and `{collection}__chunks` (double underscore). Do NOT use bare shared tables named `documents`/`document_chunks`: the Meridian seed (`docs/SPECS.md` §9) already ships a *structured* collection literally named `documents`, so `data_synth.documents` exists — a shared table by that name collides on first `apply`. Per-collection tables also match the existing one-table-per-collection pattern in `tableDDL`, drop the need for a `collection` discriminator column, and let `path` be unique per collection (the upsert key). A Zod refinement forbids `__` in collection names (so a structured collection named `people__docs` can't collide either).

```sql
create table data_{env}."{collection}__docs" (
  id uuid primary key,
  title text,
  path text not null unique,         -- source-relative path; upsert key + row_filter matching
  owner text,
  checksum text not null,            -- for idempotent re-index (skip unchanged files)
  updated_at timestamptz not null
);

create table data_{env}."{collection}__chunks" (
  id uuid primary key,
  document_id uuid not null references data_{env}."{collection}__docs"(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  tsv tsvector generated always as (to_tsvector('english', content)) stored,
  embedding vector(1536),            -- reserved; NULL until embeddings are populated (future increment)
  unique (document_id, chunk_index)
);

create index "{collection}__chunks_tsv_idx" on data_{env}."{collection}__chunks" using gin (tsv);
-- ivfflat/hnsw index on embedding deferred until embeddings are populated
```

`pgvector` extension is enabled now so the `embedding` column exists without a future migration, but nothing populates or queries it in this increment.

### 4.1 The chunk view — preserving the broker-only invariant

**Critical architectural constraint (this is where the naive design breaks the security model):** in the implemented code the broker **never** selects from base tables. `sql/build.ts` always targets `${schema}.v_${collection}`, and `apply/ddl.ts`'s `grantViewDDL()` grants the env roles (`warehousd_dev` / `warehousd_live`) `SELECT` on the **view only** — the roles have *no* privilege on base tables. This is the structural enforcement of `docs/SPECS.md` §4.1 (broker-only path).

Therefore document search must also go through a per-collection view, exactly like structured collections. `warehousd apply` generates, per document collection and env, a flat chunk-level view that pre-joins document metadata onto each chunk:

```sql
create or replace view data_{env}.v_{collection} as
  select c.id            as chunk_id,
         c.chunk_index,
         c.content,
         c.tsv,                       -- retained so search can rank on it (never returned as a field)
         d.id            as document_id,
         d.title,
         d.path,
         d.owner,
         d.updated_at
  from data_{env}."{collection}__chunks" c
  join data_{env}."{collection}__docs" d on d.id = c.document_id;
-- grant select on data_{env}.v_{collection} to warehousd_{env};  (via grantViewDDL, unchanged)
```

This keeps the surface flat (one row per chunk, document metadata denormalized on) and, crucially, means `searchDocuments` reuses the *same* view-targeting + role-grant machinery as `broker.query` — the broker-only invariant is inherited, not re-implemented. The `tsv` column is exposed in the view for ranking but is never a grantable field and never appears in `fieldsReturned`.

**Why view-only grants suffice (verified against the running setup):** in this codebase the migration/apply path runs as the `app` owner role (`APP_DATABASE_URL`, see `scripts/dev-bootstrap.ts` / `db/migrate-app.ts`), which owns both base tables and views. The env roles get only `usage` on the schema + `select` on `v_{collection}` (`grantViewDDL`). Because a non-`security_invoker` Postgres view accesses its underlying tables with the **view owner's** privileges, `warehousd_dev` can read the view without any base-table grant — this is already how structured collections work and is proven by the passing `db-roles`/`probe` tests. Document views inherit the exact same property; **do not** add base-table `select` grants to the env roles (that would weaken the invariant, and it's unnecessary).

### 4.2 DDL generation

`poc/packages/broker/src/apply/ddl.ts` currently has `tableDDL()` (field-config-driven, loops `c.fields`), `viewDDL()` (builds the flat view with `view_join` resolution), and `grantViewDDL()`. Document collections need type-based branches in `tableDDL` and `viewDDL`:
- `tableDDL`: when `type === "document"`, emit the fixed `{collection}__docs` + `{collection}__chunks` DDL from §4 instead of a single field-driven table.
- `viewDDL`: when `type === "document"`, emit the chunk-join view from §4.1 instead of the `view_join`-resolving structured view.
- `grantViewDDL`: **unchanged** — it already grants `select` on `v_{collection}` to the env role, which covers the document view for free. This is the payoff of routing search through a view.

Chunking is done in the indexer, not the database: paragraph-aware splitting, target ~500–1000 characters per chunk with overlap, so each chunk is both a good full-text match unit and small enough to feed directly into LLM context.

## 5. Indexer

`packages/broker/src/indexing` — real code, kept into MVP (not a POC-only stub), plus a CLI entry point (`warehousd index <collection>` or run as part of `warehousd apply`/`seed` — implementer's choice, document whichever is picked).

**Which content feeds which environment (invariant 5 applies to documents too).** `docs/SPECS.md` §4.5 says dev never touches real data. Synthetic *generation* is meaningless for prose, so for document collections the equivalent is **curated sample docs**: the YAML `source` directory is the **dev** content — committed sample/demo files, never real corporate documents. Live content is indexed only by an explicit, deliberate action: `warehousd index <collection> --env live --source <dir>` (or the optional `source_live` YAML key). The CLI defaults to dev; it must never silently index the same directory into both envs. The POC demo ships two small bundled directories (dev + "live", both fake but with distinct per-env canary strings) so the env wall stays demonstrable exactly like `seedLive` does for structured data.

Behavior:
1. Read the env-appropriate source directory for the given `type: document` collection (see above).
2. For each file: compute a checksum; skip if unchanged since last index (idempotent). Files present in the DB but no longer on disk are **deleted** (full-sync semantics — chunks cascade via the FK).
3. Extract text (`.md` / `.txt` for this increment). Metadata: `title` = first `# heading` in the file, else the filename without extension; `owner` = optional `owner:` key in markdown frontmatter, else null; `updated_at` = file mtime; `path` = source-relative path (the upsert key).
4. Chunk (see §4), upsert into `{collection}__docs` + `{collection}__chunks`.
5. Writes go to the base tables (`{collection}__docs` / `{collection}__chunks`), not the view — so the indexer needs a role with `INSERT`/`UPDATE`/`DELETE` on the base tables. **This is a genuine new privilege:** the env roles today hold only `SELECT` on views (`grantViewDDL`), by design. Rather than widen those read roles, `warehousd apply` grants write on the document base tables to a dedicated indexer role per env (or reuses the schema-owner/admin role the CLI already uses to run `apply` DDL — implementer's choice, but the read-path roles `warehousd_dev`/`warehousd_live` must **not** gain base-table write privileges, or the broker-only read invariant weakens). Whichever role indexes, env separation still holds: indexing dev touches only `data_synth`, indexing live only `data_live`, selected by the same `env → schema` mapping as everything else. No code path lets one indexing run touch both schemas.

## 6. Broker surface: `broker.searchDocuments`

A new method on the broker factory (`makeBroker()` in `broker.ts` currently returns `{ query, describeCollection, listCollections }`; add `searchDocuments`). It shares the entire validation pipeline with `query` — the *only* thing genuinely new is the full-text ranking predicate.

```ts
type DocSearchIntent = {
  collection: string;
  q: string;                // full-text query, → websearch_to_tsquery, always parameterized ($n)
  fields?: string[];        // same semantics as QueryIntent.fields — omit = all granted fields
  limit?: number;           // reuses DEFAULT_LIMIT (100) / MAX_LIMIT (500) from types.ts
  offset?: number;
};

broker.searchDocuments(ctx, intent): Promise<BrokerResult>   // same BrokerResult union as query
```

**Reuse the existing validation pipeline, don't fork it.** The steps in `broker.query` (`broker.ts` lines 28–58) — collection exists → `collectReferenced` fields exist on the collection → `loadActiveGrant` → every referenced field ∈ `grant.allowedFields` → select only granted fields — apply verbatim. `searchDocuments` should call the same helpers (`fieldsOf`, `loadActiveGrant`, `refuse`, `writeAudit`) so field-level enforcement and audit behavior are literally the same code, not a parallel implementation that could drift.

**SQL: extend `buildSelect`, don't write a second builder.** `sql/build.ts` already targets `${schema}.v_${collection}`, quotes columns from the granted set, ANDs `filters` into a `where[]` array, and applies `limit`/`offset`. Full-text search is added as a `q`-guarded branch in that same builder. The mechanism must be explicit (it is *not* free — `buildSelect` today has no `q` awareness and builds `selectClause` purely from granted fields):

- **Single param slot for `q`:** call the existing `param(q)` helper **once**, capture the returned `$n`, and reuse that same placeholder in both the WHERE and ORDER BY clauses. Do not call `param(q)` twice (that would allocate two slots for one value).
- **WHERE:** push `tsv @@ websearch_to_tsquery('english', $n)` onto the existing `where[]` array. `'english'` matches the generated `tsv` column's config (`to_tsvector('english', content)`) — keep them identical.
- **ORDER BY override:** when `q` is present, the ORDER BY becomes `ts_rank_cd(tsv, websearch_to_tsquery('english', $n)) desc` instead of the intent's `orderBy`. (Document search ignores `orderBy`; relevance ranking is the ordering.)
- **`_rank` + `chunk_index` in the select clause:** the `q`-branch appends `ts_rank_cd(...) as "_rank"` and `"chunk_index"` to the columns built from granted fields. These two reserved columns are *always* selected for document search, independent of the grant, and stripped from `fieldsReturned` (they're structural, not governed — see §3).

Because it's the *same* `buildSelect`, the `row_filter` predicate (§7) ANDs into the identical `where[]` array with zero extra plumbing — the security-relevant filtering lives in one place for both structured and document queries.

**No aggregation for document search.** `DocSearchIntent` deliberately omits `aggregate`/`groupBy`. `buildSelect`'s aggregate branch is keyed on `intent.aggregate?.length`, so a DocSearchIntent skips it cleanly — but the type must not carry `groupBy` either (a `group by` with no aggregate is invalid SQL). Document aggregation ("how many chunks mention X") is out of scope for this increment.

**Ranking output.** Per the select-clause note above, each result row carries a reserved `_rank` (relevance) and `chunk_index` (citation) key; `fieldsReturned` lists only the granted content fields. This keeps rank/chunk-index out of the posture/grant surface (derived/structural, never governed data) while letting the LLM cite passages and the evidence panel show relevance ordering.

Only `allow`-postured + grant-covered fields are ever selected. `path` stays internal (used server-side for `row_filter` matching via the view) and is never returned unless explicitly granted.

**Method↔collection-type matrix (so no combination is undefined):**
- `broker.searchDocuments` on a `type: structured` collection → `invalid_intent` refusal (there is no `tsv` to search).
- `broker.query` on a `type: document` collection → **allowed, unchanged.** The chunk view is a normal view with granted fields; structured queries over it work naturally (e.g. "list all document titles" = `query` with `fields: [title]`, or filter by `updated_at`). This falls out for free and gives the LLM document *listing* without search.
- `broker.describeCollection` / `listCollections` → unchanged for both types (`describeCollection` reads `c.fields`, which for documents is the fixed five-field set — correct as-is).

In the Phase 0 chat route (`docs/SPECS.md` §13), this becomes a fourth tool: `search_documents(collection, q)`, alongside `list_collections`, `describe_collection`, `query_collection`.

**Zero-touch reuse (confirmed against the code):** `db/pools.ts`'s `dataPool(pools, ctx)` maps env→pool unchanged for both indexer and search; `audit/write.ts`'s `writeAudit()` is generic over `intent`/`outcome`/`reason` and logs `searchDocuments` calls with no change (the `DocSearchIntent` serializes into the existing `intent jsonb` column).

## 7. Row-level grant scoping (pulled forward from `docs/SPECS.md` §12)

`docs/SPECS.md` §12 already earmarks the grants table to tolerate a future `row_filter jsonb` column without restructuring. **This is not yet implemented** — the column doesn't exist and nothing in the current grant-evaluation path carries it. This increment is the first thing to actually add and use it — for both document collections (restrict by `path`) and, since the broker validates it generically, structured collections too.

**Implementation note — concrete touch points in `poc/packages/broker/src/`:**
- `app.grants` (DDL, see `db/app-schema.ts`) needs a new nullable `row_filter jsonb` column **and** a partial unique index `(user_id, collection, env) where status='approved'` (see "Single active grant" below) — a migration, not a config change.
- `grants/eval.ts`'s `loadActiveGrant()` currently returns only `{ id, allowedFields }`. It must be extended to also load and return `row_filter`, and the `ActiveGrant` type in `types.ts` needs the new optional field.
- `sql/build.ts` already ANDs predicates into a `where[]` array using the `param()` helper (the `in`-list case at lines with `f.op === "in"` is the exact shape `row_filter` needs). The row-filter predicate reuses that identical code path — it's a grant-derived `Filter` appended to the same `where[]`, applied to both `buildSelect`'s structured path and the document-search path. Low-risk, and it lives in one place.
- New validation — `row_filter.field` must be a field defined on the collection (the "filterable set", see §7 Rules — deliberately *not* the user's `allowedFields`, so denied fields like `path` can gate rows without being readable). This check doesn't exist yet; add it near `broker.ts`'s existing field-validation loop, but as a separate tier applied to the grant-carried filter, not the client-supplied one.

```ts
// grant carries an optional predicate; reuse the existing Filter shape from types.ts
// (op constrained to the safe subset for grant-side filtering)
row_filter?: { field: string; op: "eq" | "in"; value: unknown };
```

The type deliberately reuses the existing `Filter` structure (`types.ts`) rather than inventing a new one, so `buildSelect`'s current `where`-clause loop consumes it directly.

**The `q()` quote-helper invariant must be widened deliberately.** `sql/build.ts`'s `const q = (id) => \`"${id}"\`` carries the comment *"caller guarantees id ∈ grantedFields (safe to quote)"*. A `row_filter` on `path` breaks that stated invariant — `path` is not in `grantedFields`. Quoting stays injection-safe (the value is still parameterized; only the identifier is interpolated), **but the safety argument now rests on a different guarantee** and the comment must be updated to say so: *identifiers reaching `q()` are drawn from the collection's YAML-defined field set (granted fields for client intents, plus the grant-author-supplied `row_filter.field` validated against the same YAML set) — never from raw client input.* Without this correction the code's own safety documentation would be false, inviting a future edit that trusts it wrongly.

**Single active grant — close the row_filter escalation.** `grants/eval.ts`'s `loadActiveGrant` does `order by requested_at desc limit 1`: most-recent-approved wins. If a user holds two approved grants on the same (collection, env) — one restrictive with `row_filter`, one broader without — the broker silently uses the newest and the restriction evaporates. Row-level scoping's security therefore depends on **at most one active grant per (user, collection, env)**. Enforce it structurally, not by convention: a partial unique index on `app.grants (user_id, collection, env) where status='approved'`. (This also matches the existing mental model — the code already treats "the active grant" as singular.) Document this as a required migration alongside the `row_filter` column.

Rules:
- **`row_filter.field` is validated against the collection's YAML `allow`-postured fields, NOT the user's `allowed_fields` grant.** This distinction matters and resolves a contradiction: admins restrict documents by `path`, but `path` is `posture: deny` (§3) so it can never be in any user's `allowed_fields`. A grant-set check would make path-scoping impossible. The correct tier: the *grant author* (a manager/admin, trusted) sets `row_filter` on a field the *collection schema* permits filtering on, and the field is used only in the `WHERE` clause — never selected, never returned. So a denied field like `path` can gate rows without ever being readable. This mirrors the existing security model: what you can *filter on* (server-constructed) is distinct from what you can *read* (grant-covered) — the difference is that for `row_filter` the filter is author-supplied at grant time, not client-supplied at query time, so a slightly wider field set is safe.
  - To keep `path`-scoping working while `path` stays unreadable, `path` is added to a per-collection **filterable set** (all YAML fields regardless of posture, for the trusted grant-author path only). Client-supplied `QueryIntent.filters` remain restricted to `allowed_fields` exactly as today — this widening applies *only* to the grant-carried `row_filter`, which no client can set.
- The predicate is built server-side via the existing `param()`/`where[]` machinery (never string-concatenated) and ANDed into the query/search's `WHERE` clause.
- For document collections, admins restrict access by `path`, e.g. a grant covering only `hr/pto.md` and `hr/benefits.md`:
  ```ts
  {
    collection: "policies",
    env: "dev",
    allowed_fields: ["title", "content"],
    row_filter: { field: "path", op: "in", value: ["hr/pto.md", "hr/benefits.md"] }
  }
  ```
- **Empty `in`-list means deny-all, enforced explicitly.** A `row_filter: { op: "in", value: [] }` must reject *every* row. `sql/build.ts`'s current `in`-branch would emit `"path" in ()`, which is a Postgres syntax error — a crash, not a safe denial. The builder must special-case an empty `in`-list to a constant-false predicate (`false` / `1=0`) so the "denied means absent" guarantee holds instead of erroring. Add an acceptance-test case for it.
- **Denied-row semantics:** a row excluded by `row_filter` behaves exactly like "denied means absent" (`docs/SPECS.md` §4.4) — it is silently omitted from results, not surfaced as a distinguishable refusal. This matches how field-level denial already works and avoids leaking the existence/count of restricted documents through a different code path.
- No grant-request UI changes required for the POC beyond a simple document picker (multi-select of `path`s) shown in the Grants panel when the target collection is `type: document`.

## 8. Acceptance tests (additions to `docs/SPECS.md` §10)

1. **Full-text ranking:** a search against a seeded document collection returns chunks ranked by relevance (`ts_rank_cd`), with only grant-covered fields present.
2. **Field-level enforcement (documents):** a grant excluding `content` on a document collection returns chunks with the `content` key **absent** (not null/empty) from every row.
3. **Row-filter enforcement:** a grant with `row_filter: { field: "path", op: "in", value: [...] }` returns zero rows for out-of-filter documents — asserted as silent omission, not an error or a distinguishable refusal reason.
4. **Row-filter leak probe (extends test 4's adversarial set):** hostile intents attempting to bypass `row_filter` (path traversal strings, SQL fragments in `q`, oversized limits) — assert zero occurrences of restricted document content in response bodies, error messages, and logs. New hostile intents go into `probes.json` per `docs/SPECS.md` §14 (data-driven, no code changes).
5. **Idempotent re-index + deletion sync:** running the indexer twice on unchanged files produces no duplicate rows (checksum skip); a modified file re-indexes and old chunks for that document are replaced; a file removed from the source directory disappears from `__docs` and (via cascade) `__chunks`.
6. **Dual-role isolation (indexer):** the indexer targeting dev cannot write to `data_live.*` and vice versa (extends test 1/8's role-separation pattern to the indexing path); the dev/live source directories are distinct and per-env canary strings appear only in their own env.
7. **View-only read privilege:** `warehousd_dev` can `select` from `data_synth.v_{collection}` (the document view) but gets a permission error on `data_synth."{collection}__docs"` / `"{collection}__chunks"` directly — proving base-table reads are impossible for the env role even for documents (extends test 1 to the document path; verifies the §4.1 view-owner-privilege claim actually holds as built).
8. **Empty in-list denies all:** a `row_filter: { field: "path", op: "in", value: [] }` returns zero rows (not a DB error) — asserts the constant-false special-case.
9. **Reserved columns present, ungoverned:** document search results carry `_rank` and `chunk_index` on every row, and neither appears in `fieldsReturned`; `tsv` and (unless explicitly granted) `path` never appear in any result row.
10. **Single-active-grant constraint:** attempting to approve a second grant for the same (user, collection, env) fails on the partial unique index — proving the row_filter escalation path is structurally closed.
11. **Audit completeness:** every `searchDocuments` call — allowed or refused — writes an audit event, consistent with test 9 of `docs/SPECS.md` §10.
12. **Type matrix:** `searchDocuments` on a structured collection → `invalid_intent`; `broker.query` on a document collection returns granted fields normally (e.g. `fields: [title]` lists documents); config load rejects a collection name containing `__` and a document collection with a non-fixed field name or missing `source`.

## 9. Repo/file additions

```
packages/broker/src/indexing/       # NEW: chunker, text extraction, checksum-based upsert
packages/broker/src/broker.ts       # EDIT: add searchDocuments to makeBroker's returned object
packages/broker/src/sql/build.ts    # EDIT: q → tsv match + ts_rank_cd order; row_filter into where[]
packages/broker/src/grants/eval.ts  # EDIT: load & return row_filter on ActiveGrant
packages/broker/src/types.ts        # EDIT: DocSearchIntent, ActiveGrant.rowFilter (via grants/eval)
packages/broker/src/config/schema.ts# EDIT: collection `type` + document `source`
packages/broker/src/apply/ddl.ts    # EDIT: type branch in tableDDL + viewDDL (grantViewDDL unchanged)
packages/broker/test/indexing.test.ts
packages/broker/test/search-documents.test.ts
packages/cli/src/commands/index.ts  # NEW: `warehousd index <collection>` (or folded into apply/seed — implementer's choice)
```

Note there is **no** separate `src/search/` module — document search is `buildSelect` extended and a thin `searchDocuments` wrapper reusing `broker.query`'s helpers, keeping structured and document paths on shared code. Document base-table + view DDL is applied by `warehousd apply`, same as views for structured collections (`docs/SPECS.md` §5.3).

---

*This spec is additive to `docs/SPECS.md`. Once approved, convert to a TDD implementation plan with `writing-plans`, scoped as a Phase 0 increment (kept into MVP per §13's "everything except the two throwaway pieces is production code").*
