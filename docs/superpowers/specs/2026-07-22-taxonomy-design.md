# Taxonomy (Vocabularies & Terms) — Design

**Status:** Approved (brainstormed 2026-07-22) · **Scope:** pre-Phase-1 increment on the Phase 0.5 codebase
**Goal:** term-based access control — scope a grant to a collection, an item, all items of a term, a specific document, or all documents of a term — with zero new enforcement machinery.

## 1. Naming

Drupal-style model, resolving the "category vs tag vs taxonomy" question:

- **Vocabulary** — a named axis of classification (flat list of them). The demo ships one: `category`.
- **Term** — a value inside a vocabulary. Single-level in MVP; `parent_id` is reserved (nullable, unused) so hierarchy is additive later, like the reserved `embedding` column.
- **Taxonomy** — the feature as a whole (`taxonomies:` YAML block, `taxonomy:` collection binding).

Each vocabulary and term has: **id** (uuid, internal identity), **slug** (git-stable key used in YAML, frontmatter, and data rows), **label** (display name, freely renameable — lives only in `app.terms`/`app.vocabularies`, so renames need no re-index). Changing a *slug* is a real migration (same weight as renaming a collection); changing a *label* is free.

## 2. Decisions (locked during brainstorming)

1. **Exactly one term per row per vocabulary** (multi-valued = post-MVP; would need a join table + array operators in the SQL builder).
2. **Terms are single-level in MVP.** Hierarchy reserved via `parent_id`. When it arrives, grant semantics stay **exact-match** (a term grant reaches only rows tagged exactly that term); descendant-inclusion would be an explicit later flag.
3. **Term stored as slug (text) on data rows.** Integrity enforced at write time (indexer/synthetic/seed validate against the config), not by cross-schema FK.
4. **No management UI.** Vocabularies/terms are declared in `warehousd.yml` (governance-in-git) and upserted by `apply`. `apply` never deletes terms (rows may reference them; removal is a manual operation until a UI exists).
5. **Access control = existing `row_filter`.** The term column is a normal YAML field with a posture; scoping a grant to terms is `row_filter { field: "<vocab-slug>", op: "in", value: [<term slugs>] }`. The hardened SQL builder (`sql/build.ts`) and broker validation order are untouched.

## 3. Config surface

```yaml
taxonomies:
  category:                      # vocabulary slug → becomes the column name on bound collections
    label: Category
    terms:
      hr:       { label: HR }
      finance:  { label: Finance }
      # ...

collections:
  documents:                     # structured collection
    taxonomy: category           # binds the vocabulary; adds/converts a `category` text field
    fields:
      category: { type: text, posture: allow }   # optional — auto-added as text/allow if omitted
  policies:                      # document collection
    type: document
    taxonomy: category
    fields:
      category: { posture: allow }               # the one extra field beyond the fixed doc set
```

Validation (Zod, `config/schema.ts`):
- `taxonomy:` must reference a declared vocabulary.
- Vocabulary slug: `/^[a-z][a-z0-9_]*$/`, no `__`, and not a reserved column name (`title`, `content`, `path`, `owner`, `updated_at`, `id`, `checksum`, `chunk_id`, `chunk_index`, `document_id`, `tsv`, `_rank`).
- Term slug: `/^[a-z0-9][a-z0-9-]*$/`.
- The bound field, if declared, must be type `text` (or untyped) and may not carry `pk`/`fk`/`view_join`.
- If not declared, the field is auto-added as `{ type: text, posture: allow }` (both collection types). Document collections accept the vocabulary slug as the one field beyond `DOCUMENT_FIELDS`.

## 4. Storage

```sql
create table app.vocabularies (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  label text not null);
create table app.terms (
  id uuid primary key default gen_random_uuid(),
  vocabulary_id uuid not null references app.vocabularies(id) on delete cascade,
  slug text not null,
  label text not null,
  parent_id uuid references app.terms(id),   -- reserved for hierarchy, unused in MVP
  unique (vocabulary_id, slug));
```

- `apply` upserts vocabularies/terms **by slug** (labels update on conflict; never deletes).
- Bound **structured** collections: the term field is a normal stored column (already emitted by `tableDDL` once the transform adds it to `fields`); an `add column if not exists` keeps re-apply working on existing tables.
- Bound **document** collections: `{collection}__docs` gains a `"<vocab-slug>" text` column (create + `add column if not exists`); the chunk view `v_{collection}` selects it via `d."<slug>"`.
- Data roles get `select` on `app.vocabularies`/`app.terms` (metadata, shared across envs — terms are not governed data).

## 5. Writers validate terms

- **Indexer:** frontmatter key = vocabulary slug (e.g. `category: hr`). For a bound collection, a missing or unknown term slug **fails the file by name** (indexing aborts — the file must be fixed). Column written on insert and update.
- **Synthetic generator:** for a bound collection, the term field is generated by a deterministic pick from the vocabulary's term slugs (config-driven, no DB read).
- **Meridian seed:** every dev doc and live doc carries a `category:` frontmatter term; `documents` synthetic rows carry term slugs (replacing the old free-text `category` wordlist values).

## 6. Enforcement (unchanged, by design)

- The term field participates in postures/grants like any field: grantable when `posture: allow`, gate-only when `posture: deny` (readable never, still usable in `row_filter` — same rule that lets `path` gate document rows).
- Term-scoped grant = `row_filter { field: <slug>, op: "in", value: [...] }` set at approval time. ANDed server-side; empty in-list = constant-false; excluded rows silently absent; single-active-grant index makes it non-bypassable.
- Covers all five access shapes: whole collection (no row_filter), one item (`id eq`), items-of-term (`<slug> in`), one document (`path in`, shipped in 0.5), documents-of-term (`<slug> in`).

## 7. Demo arc (Meridian)

Vocabulary `category` with 12 terms: `contracts, finance, benefits, hr, engineering, security, compliance, sales, marketing, operations, legal, onboarding`. Bound to `documents` (structured) and `policies` (document). Doc terms: `expenses→finance`, `pto→benefits`, `remote-work→hr` (dev); `compliance→compliance`, `security→security` (live). Mia's `policies` grant is scoped `category in [hr, benefits]` — she can search the remote-work/PTO policies but the expenses policy is silently absent; Grants panel gets a term multi-select next to the doc-path picker.

## 8. Acceptance

1. Config: binding to an undeclared vocabulary, bad slugs, reserved slugs, non-text bound field all rejected; omitted bound field auto-added text/allow.
2. Apply: vocabularies/terms upserted idempotently; label rename updates in place; no duplicates; term columns exist on bound tables and views (both envs).
3. Synthetic: bound fields contain only valid term slugs; deterministic under a fixed seed.
4. Indexer: term parsed from frontmatter; missing/unknown term fails with the file path in the error; term column populated; unbound collections unaffected.
5. Broker (no code change expected): term-scoped grant filters structured queries and document search; client filters AND with the row_filter (no widening); term field respects `field_denied`/absence when un-granted; empty in-list denies all; every outcome audited; env parity holds.
6. Full Phase 0/0.5 suite still green.

## 9. Out of scope (future)

Multi-valued terms per row · term hierarchy semantics (`parent_id` reserved) · additional vocabularies in the demo · taxonomy management UI · term delete/rename tooling · IdP-driven term assignment.
