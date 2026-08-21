# Glossary

The words **warehousd** uses, and the ones it deliberately does not. The core model is one sentence: **a Collection holds Documents; each Document has Fields.**

| Term | Meaning |
|---|---|
| **Collection** | A named, governed set of documents. `type: dataset` for queryable tables, `type: file` for indexed files. Backed by Postgres tables, one set per environment. |
| **Document** | One governed, queryable record in a collection. For a dataset collection, one table row. For a file collection, one indexed segment of a parsed file. |
| **Field** | A document's governed attribute. Postures and grants operate on fields. |
| **File** | An ingested source (`.md`/`.txt`) parsed into one or more documents. A file is not a document; it *contains* them. |
| **Posture** | A field's declared setting in `warehousd.yml`, on two axes: `read` and `write`, each `allow` (grantable) or `deny` (never grantable). Absent means denied on both. A bare `allow`/`deny` sets `read` and leaves `write` denied. |
| **Grant** | `(workspace, user, collection, purpose, verbs, allowed fields, environment, mode, expiry)`, optionally narrowed via document filter (array of predicates on any field, including metadata and taxonomy fields). Requested, approved, evaluated fresh on every query. |
| **Verb** | What a grant permits: `read`, `create`, `update`, `delete`, `approve`. Which verbs a collection can support at all follows from its type, not from the grant. |
| **Purpose** | The short label and free text a user states when requesting access. Stored on the grant and stamped on every audit event it produces. |
| **Environment** | `dev` (synthetic data) or `live` (real data). Carried as an OAuth scope, never as a request parameter. |
| **Workspace** | The tenant a user, grant, audit event and document belong to. A user may belong to several, with a role per workspace. Derived from the authenticated identity and its membership, never named freely by a request. |
| **Intent** | A structured query *proposal* from a client. The broker re-validates it and builds the SQL itself. |
| **Refusal** | A denial carrying a reason code (`no_grant`, `field_denied`, …) and nothing else — no denied value, no SQL. |
| **Relation** | A field that composes documents from another collection into this one. Declared on the host collection, which names the target and the target fields it exposes, each with a posture of its own. Read-only. A relation is not a join and not a foreign key: it is a set of the host's own fields whose values happen to come from somewhere else. |
| **Broker** | The library that turns `(identity, grants, intent)` into documents or a refusal. The only thing that reads collection data. |
| **Adapter** | A thin protocol translator in front of the broker — the MCP server, the web UI, anything future. |
| **Taxonomy / vocabulary** | A named set of **terms** bound to a collection, so grants can be scoped to a subset of documents. Supports single or multiple terms per document; may be defined inline (YAML) or sourced from a dataset collection. |
| **ACL** | The list of principals a single document is restricted to. A document with no ACL is readable by anyone the grant covers; a document with one is readable only by its principals. An ACL narrows a grant and never widens one. Only on a collection declaring `acl: true`. |
| **Principal** | Who a caller *is*, for an ACL: `user:<id>` or `group:<name>`. The namespace is required — without it a group named the same as a user id would grant that user's access. |
| **Group** | A named set of users, held in warehousd's own `app.user_groups` and derived from the caller's id on every request. Synced from an IdP's group claim on login, or pinned by an admin. Never read from a token. |
| **Row** | Internal only: the SQL tuple the broker materializes, 1:1 with a document. It lives in the query-builder and DDL layers and never appears in a public contract. |

## The name

**The name is lowercase — warehousd, always and everywhere, including where a sentence would capitalise it. So don't start a sentence with it.**

The name is not only a brand: it is the command you type (`warehousd start`), the package you install (`warehousd` on npm), the file you commit (`warehousd.yml`), the directory it writes (`.warehousd/`) and the prefix on every environment variable (`WAREHOUSD_*`, uppercase only because shells are). Capitalising it in prose forks the product from the thing that is typed, and a reader who meets "Warehousd" in a paragraph and `warehousd` in the next code block has to work out whether they are the same. They are, so it is spelled one way.

The cost of that rule is that a lowercase word opening a sentence reads as a typo. The fix is to write around it — "At 0.1.0-rc.1, warehousd is a release candidate", not "warehousd is at 0.1.0-rc.1" — never to capitalise it.

**Bold it once per document, on the first mention in prose, and never again in that document.** Introducing a term in bold is ordinary editorial practice, and it is what stops a lowercase name from reading as a stray word the first time it appears — after one **warehousd** the reader knows it is a name and every later mention is legible bare. Bolding *every* occurrence is the failure mode to avoid: the name is in nearly every paragraph here, and marking all of them would drain `**bold**` of the emphasis it is doing elsewhere on the same page. Skip the first-mention bold where the heading above already carries the name, or where it would land beside other bold in the same sentence.

Backticks are for the literal string: the command, the package, the file, the env var, the roles (`warehousd_dev`). Bare lowercase is for the product. `warehousd start` is a command; warehousd is what runs.

Identifiers follow their language, not this rule: `WarehousdConfig` is PascalCase because TypeScript types are, and `WAREHOUSD_PROJECT_DIR` is uppercase because environment variables are. Neither is a mention of the name in prose.

## Words we don't use

- **Item** — deleted. "Document" is the only word for a queryable record.
- **Chunk** — retired as a noun. "Chunking" is the verb for the segmentation step; each resulting segment is a Document.
- **Table** and **column** — Postgres implementation details. In the product surface they are Collection and Field.
- **Join** — internal only. In the query builder and the DDL a relation is a join; in the product surface it is a Relation, and what a caller reads is a field.
