# Terminology Glossary

**Core model:** A Collection holds Documents; each Document has Fields.

## Canonical Terms

| Concept | Canonical term | Definition | Retired / demoted |
|---|---|---|---|
| the dataset | **Collection** | A named, governed set of documents, `type: dataset \| file`. Backed by Postgres tables per env. | "table" → Postgres impl detail only |
| a record | **Document** | One governed, queryable record in a collection; has fields. A `dataset` document = one table row; a `file` document = one searchable segment of a file. | **"item" — delete; never use** |
| an attribute | **Field** | A document's governed attribute (postures/grants operate on fields). | "column" → raw DDL only |
| a raw source | **File** | An ingested source (`.md`/`.txt`, later PDF/DOCX) parsed into one or more documents. This is what code currently *mis*names "document". | — |
| SQL tuple | **Row** | Internal only: the SQL result the broker materializes, 1:1 with a document. Lives in the query-builder/DDL layer, never in the public contract. | remove from public API surface |

## Critical Terminology Flips

### Flip 1: "document" changes meaning

**Before:** `type: document`, `__docs`, `ExtractedDoc` = *file* (an ingested source)
**After:** `type: file`, `__files`, `ExtractedFile` = *file*; "document" = queryable record

**Why:** The old terminology inverted the hierarchy. A File now explicitly holds many Documents.

### Flip 2: A file's chunks become documents

**Before:** 1 File → many Chunks (`__chunks` table)
**After:** 1 File → many Documents (`__documents` table, per-collection naming)

**Why:** Chunks are no longer a noun. "Chunking" is the verb for the segmentation step. Each chunk-segment is now a Document in the collection.

## Special Notes

- **Row** is preserved as an internal-only term for SQL result tuples. Never appear in public API or grant scoping.
- **Chunk** is retired as a noun entirely. Use only as a verb: "chunking is the segmentation step."
- **Item** is deleted; "document" is the sole word for queryable records.
- Backward-compatibility: None. This is a new system with no live data to preserve.
