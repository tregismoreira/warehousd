# Component status

Per component, what is fully implemented versus deliberately narrowed or not yet built. This table is the authoritative answer to "is that real?" — it is checked against the code rather than against intentions, and [README.md](../README.md#component-status) points here.

For what is *planned* rather than built, see [roadmap.md](roadmap.md).

## Release status

At **0.1.0-rc.1**, warehousd is a release candidate, not meant to be used in production. `real` below means implemented and covered by this repository's own suite. It does not mean audited: there has been no external security review and no production deployment behind any of it. Treat the table as a map of what exists to evaluate, not as an assurance that it holds up under attack.

| Component | Status | Notes |
|---|---|---|
| Broker enforcement — postures, grants, field/document/term scoping | **real** | |
| Filter operators, ordering, pagination | **real** | Server-built SQL from named views; fixed operator whitelist. |
| Aggregation (`avg`/`sum`/`count`/`min`/`max` + `groupBy`) | **real** | Only over fields the caller can already read row by row. |
| Dev/live isolation | **real** | Two Postgres roles, two pools, selected by token scope. |
| Synthetic data generation | **real** | From the schema only; deterministic by seed; FK-consistent. |
| File collections + full-text search | **real** | `.md`/`.txt`; `tsvector` + GIN, `ts_rank_cd` ordering. |
| Taxonomies and term-scoped grants | **real** | Several vocabularies per collection; single- or multi-value; terms from YAML or from a dataset collection's rows. |
| Multi-predicate grant scoping | **real** | A grant's document filter is a list of predicates, ANDed — across vocabularies, paths, and plain metadata fields. |
| OAuth 2.1 provider, env-as-scope, dynamic client registration | **real** | 15-min access tokens; scope rules re-run on refresh. |
| MCP endpoint (streamable HTTP) | **real** | |
| REST API (`/v1`) | **real** | Same broker and grants as MCP; one status-code table, no per-route invention. |
| API keys, rotation, revocation, collection ceiling | **real** | Hashed at rest; revocation takes effect on the next call — grants load fresh per request. |
| RFC 8693 token exchange | **real** | Trusted OIDC issuers; the acting user, not a service account, is the subject of the grant check. |
| SSO — OIDC and SAML | **real** | Better Auth SSO plugin; automated OIDC and SAML round trips against Keycloak. Connecting a hosted IdP is a [documented manual runbook](configure-sso.md). |
| IdP group→role mapping | **real** | Per provider in `warehousd.yml`: a group claim and a group→role map. Highest matching role wins; unmapped groups are ignored; a deployment that declares no map still provisions `member`. The *role* is set at registration only, so a console promotion is never undone by the next login. The *group list* is persisted to `app.user_groups` on every login — it is what `group:` ACL principals resolve against, and freezing it at first login would be worse than not offering it. Console-pinned memberships survive a re-sync, and an assertion carrying no group claim changes nothing. |
| Admin / manager / member web UI | **real** | |
| Audit log | **real** | Insert-only for the app role. Sink is configurable: `postgres`, `stdout-json`, `webhook`. |
| Real-data import | **real** | Admin-only CSV/JSON/XLSX, with append, upsert and delete modes and a dry-run preview. Every mode writes revisions: the import role holds no UPDATE on a data column and no DELETE at all, so a correction supersedes a value rather than overwriting it. |
| App-schema migrations | **real** | Ordered and versioned, recorded in `app.schema_migrations`. Applied under an advisory lock so concurrent boots cannot race, each in its own transaction so a failure rolls back and can be retried rather than leaving a half-applied schema. Collection DDL remains additive — type changes, renames and drops go through `warehousd migrate`, see [migrations.md](migrations.md). |
| Semantic / vector search | **real** | `text`, `semantic` and `hybrid` modes on `search_documents`; HNSW over pgvector, dimension from config. Hybrid is Reciprocal Rank Fusion over two CTEs that both read one scoped CTE, so grant predicates apply before either ranking and either LIMIT. The query vector is derived server-side — a client cannot supply one. Local ONNX embedder by default; OpenAI-compatible endpoints are opt-in. |
| `warehousd deploy` | **real** | Provisions to Fly.io, Railway or a rendered Compose stack, each behind one `DeployTarget`; enforces the demo-off expectation mechanically whichever it is. |
| Database provisioning through a provider CLI | **real** for Neon, **partial** for Supabase | One `DbHost` per provider drives `neon`/`supabase` to create the project, records it in `state.json` so a redeploy reconnects rather than creating a second, and deletes it on `--destroy`. Neon returns a connection URI, so nothing is derived. Supabase prints none, so warehousd assembles the session-pooler string from the ref, region and the password it generated — verified by the pre-flight's `db-reachable`, not by us. |
| Guided `warehousd init` | **real** | Picks the local database and the production database from the registries, then checks each CLI those answers need and offers to install it through whichever package manager this machine has. Never installs without consent, never runs `sudo`, never automates a browser login. `--manual` skips all of it. |
| Write path (MCP, REST, and review queue) | **real** | Append-only revisions; `proposal_only` grants hold writes pending until a human approves. Approve/reject are never MCP tools. |
| Masking / transform postures | **real** | `read: mask` with seven transforms, computed in SQL so the raw value is never fetched. Masked fields are projection-only — filtering, ordering, grouping and aggregating over one are refused, which is what stops a mask being decorative. `unmask: allow` makes the raw value separately grantable. |
| Connect-in-place to external databases | **real** | `postgres_fdw` foreign tables inside `data_live`, so views, grants, postures and the SQL builder are unchanged. Read-only enforced by the database; columns declared rather than imported; `apply` verifies the remote matches. Tenant isolation is the view predicate alone — one wall rather than two, see [SECURITY.md](../SECURITY.md). |
| PDF/DOCX extraction | **real** | `.pdf` and `.docx` indexed beside `.md`/`.txt`, originals stored, sidecar `.yml` supplies owner and terms. A scanned PDF with no extractable text is refused rather than indexed empty. |
| Document upload UI | **real** | Admin-only multi-file and folder upload, resumable: each file is hashed in the browser and only what the collection does not already hold is sent. Same ingestion path as `warehousd index`. |
| Per-document ACLs | **real** | `acl: true` per collection. No ACL row means public within the grant; an ACL row means only its `user:`/`group:` principals. One fixed predicate ANDed into the same `WHERE` every read uses, so aggregates count what the caller may see; the write path re-evaluates the same rule in process through one entry point, asserted against the SQL by a parity suite. Editing an ACL is authorised by console role or a client's `can_manage_acl` flag — not by a grant verb, and never over MCP. Datasets are addressed by their primary key, file collections by `path` — which survives a re-index and a delete/restore, where the `file_id` would not. Connect-in-place collections are refused at config load: warehousd does not own those rows. |
| Multi-tenancy (`workspace_id`) | **real** | A deployment hosts many workspaces, isolated by a view predicate and RLS on the data plane and by RLS plus an explicit predicate on the control plane. A user may belong to several workspaces with a role per workspace (`app.workspace_members`), resolved from the session's active workspace at every auth boundary. The console has a switcher and a per-workspace Members page; `/v1/platform/*` lets a consuming application provision workspaces and clients programmatically, behind a platform key and off (`workspaces.enabled: false`) by default. |
| SCIM, compliance exports | *not built* | |
