# Glossary

The words warehousd uses, and the ones it deliberately does not. The core model
is one sentence: **a Collection holds Documents; each Document has Fields.**

| Term | Meaning |
|---|---|
| **Collection** | A named, governed set of documents. `type: dataset` for queryable tables, `type: file` for indexed files. Backed by Postgres tables, one set per environment. |
| **Document** | One governed, queryable record in a collection. For a dataset collection, one table row. For a file collection, one indexed segment of a parsed file. |
| **Field** | A document's governed attribute. Postures and grants operate on fields. |
| **File** | An ingested source (`.md`/`.txt`) parsed into one or more documents. A file is not a document; it *contains* them. |
| **Posture** | A field's declared setting in `warehousd.yml`, on two axes: `read` and `write`, each `allow` (grantable) or `deny` (never grantable). Absent means denied on both. A bare `allow`/`deny` sets `read` and leaves `write` denied. |
| **Grant** | `(org, user, collection, purpose, verbs, allowed fields, environment, mode, expiry)`, optionally narrowed to documents or taxonomy terms. Requested, approved, evaluated fresh on every query. |
| **Verb** | What a grant permits: `read`, `create`, `update`, `delete`, `approve`. Which verbs a collection can support at all follows from its type, not from the grant. |
| **Purpose** | The short label and free text a user states when requesting access. Stored on the grant and stamped on every audit event it produces. |
| **Environment** | `dev` (synthetic data) or `live` (real data). Carried as an OAuth scope, never as a request parameter. |
| **Organization** | The tenant a user, grant, audit event and document belong to. Derived from the authenticated identity, never from a request. |
| **Intent** | A structured query *proposal* from a client. The broker re-validates it and builds the SQL itself. |
| **Refusal** | A denial carrying a reason code (`no_grant`, `field_denied`, …) and nothing else — no denied value, no SQL. |
| **Broker** | The library that turns `(identity, grants, intent)` into documents or a refusal. The only thing that reads collection data. |
| **Adapter** | A thin protocol translator in front of the broker — the MCP server, the web UI, anything future. |
| **Taxonomy / vocabulary** | A named set of **terms** bound to a collection, so grants can be scoped to a subset of documents. |
| **Row** | Internal only: the SQL tuple the broker materializes, 1:1 with a document. It lives in the query-builder and DDL layers and never appears in a public contract. |

## Words we don't use

- **Item** — deleted. "Document" is the only word for a queryable record.
- **Chunk** — retired as a noun. "Chunking" is the verb for the segmentation
  step; each resulting segment is a Document.
- **Table** and **column** — Postgres implementation details. In the product
  surface they are Collection and Field.
