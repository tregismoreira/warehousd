# Unify data-model terminology: Collection holds Documents, each Document has Fields

## Problem

warehousd's vocabulary had drifted: the same "record inside a collection" was called **row**, **item**, and **document** in different places, `row_filter` and `.rows` leaked SQL-layer naming into the public broker contract, and the config's `type: "document"` collection kind actually meant "an ingested file," not a queryable record — the opposite of what the word suggests. This ambiguity made the spec, code, and UI harder to reason about and would only get worse as more adapters (REST/CMS/app) land.

## Solution

Standardized on the MongoDB/Solr model: **a Collection holds Documents; each Document has Fields.** Concretely:

- `type: "document"` (a directory of files) → `type: "file"`; the word *document* now means the queryable record instead.
- A file's parsed segments are now **Documents**, not "chunks" — `chunk` is retired as a noun everywhere (kept only as the verb "chunking"), so `{collection}__docs`/`{collection}__chunks` tables become `{collection}__files`/`{collection}__documents`, and `chunk_index`/`document_id` (FK) become `document_seq`/`file_id`.
- The broker's public contract now returns `documents: Document[]` instead of `rows`, and grant scoping uses `DocumentFilter`/`document_filter` instead of `RowFilter`/`row_filter` (including the Postgres column on `app.grants`).
- Added `docs/GLOSSARY.md` as the canonical term reference, linked from `docs/SPECS.md` §3, which was rewritten to match.
- Propagated the rename through the schema/config layer, DDL, indexing pipeline, synthetic data generator, seed config (the demo's `documents` collection was renamed to `announcements` to stop colliding with the new meaning of "document"), web UI/API routes, and the full test suite.

Along the way this surfaced and fixed several real bugs the terminology confusion was masking: `searchDocuments` checking a stale `type` value (would have refused all file-collection searches), the grants API silently dropping path/term scoping because it still wrote the old `rowFilter` key, and a doc-paths API route querying a table name that no longer existed post-DDL-rename.

## Jira tickets

- None

## Dependencies

- None

## How to Test

1. `pnpm -C mvp/packages/broker exec vitest run test/config.test.ts test/sql-build.test.ts test/types.test.ts` — DB-independent unit tests, should pass (24/24).
2. `pnpm -C mvp/packages/broker exec tsc -p tsconfig.json` and `pnpm -C mvp/apps/web build` — should type-check/build cleanly.
3. Bring up the test Postgres (`pnpm -C mvp test:up`) and run `pnpm -C mvp test` — full broker/CLI integration suite, including the document-indexing acceptance list, should pass against the renamed schema.
4. `warehousd apply` against a fresh DB and confirm `{collection}__files` / `{collection}__documents` / `v_{collection}` are created with the new column names, and that the web console's Grants panel still shows "File paths" scoping correctly for the `policies` collection.
