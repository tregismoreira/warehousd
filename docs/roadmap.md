# Roadmap

What is planned, and where the open-source line sits. For what is built *today*, [status.md](status.md) is the authoritative list — it marks each component `real`, `partial` or `not built`, and it is checked against the code rather than against intentions.

At 0.1.0-rc.1, **warehousd** is a release candidate that is not meant to be used in production. That changes nothing below: the open-core commitment holds from the first release, and the planned items are as Apache 2.0 as the shipped ones.

## The open-core line

**Everything shipped is Apache 2.0, and stays Apache 2.0.** That is the commitment, and it is not conditional on what gets built later. The broker and its enforcement, postures and grants, dev/live isolation, the audit trail, file collections and search, taxonomies, the OAuth provider, the MCP endpoint, the REST API, API keys and token exchange, SSO, the web UI, the CLI, and `warehousd deploy` are all in that set. So is everything listed under [Planned](#planned) below.

If a hosted or paid offering ever exists, these are the shapes it would take — listed here so the boundary is visible now rather than discovered later:

- approval workflows at organizational scale (delegation, escalation, on-call rotations for grant review)
- SCIM provisioning and compliance exports
- real multi-tenancy — one deployment serving mutually distrusting organizations
- a hosted control plane

None of that removes anything from the open-source side. The test is simple: if it is in the repository today, it is Apache 2.0 tomorrow.

## Planned

- **Aggregate-only postures** with inference-leak protection — computing `avg(base_salary)` without row access. This needs minimum-group-size or differential-privacy machinery to be safe, which is why it is not built: aggregation is currently permitted only over fields the caller could already read row by row, so an aggregate can never reveal anything new.

- **Streaming imports.** `validateImportRows` is synchronous and pure by design — which is what makes it testable without a database — so it materialises the whole payload in memory, and `DEFAULT_MAX_ROWS` caps a single import at 10,000 rows. For a spreadsheet-heavy deployment the answer is to chunk the file into batches in the CLI, not to raise the constant: the ceiling is what keeps one import from being one very large transaction.

- **Audit retention and export.** `audit.sink` now chooses where a decision goes (`postgres`, `stdout-json`, `webhook`), which covers forwarding to a SIEM. What it does not cover is the other two halves of the same question: a retention policy for `app.audit_events`, and an export the console can produce for an auditor who wants the trail as a file rather than as a table.

- **Grant expiry notifications.** Expiry now has a lifecycle — a per-collection default, an expiring-soon panel, and an access-review view keyed on last use — but every part of it is something a person has to come and look at. Telling the holder and the approver that access lapses on Friday needs an outbound channel the deployment does not have yet, which is why it is a separate item.

- **Server-sent events over the change feed.** `GET /v1/changes` is already a correct, cursor-based tail — see [docs/events.md](events.md) for the full analysis — but polling puts a floor on review-UI latency and costs one indexed query per poll even against an idle workspace. SSE would push the same identifiers-only rows as they are written, grant-checked continuously through the same session a live review UI already holds, rather than once at subscribe time the way a webhook would be. Not built yet: the honest next step is measuring the polling cost SSE would actually save before building the push path.

- **Outbound notification channels — webhook and Slack/email.** Neither exists yet. A webhook needs delivery-state tracking, retry with backoff, and per-subscription grant scoping before it is safe to expose, and Slack/email is the outbound channel "Grant expiry notifications" above is blocked on. [docs/events.md](events.md) works out the event taxonomy, the identifiers-only payload rule every transport is bound by, and a recommended build order — SSE first, webhook next, Slack/email after — for whichever of these gets picked up.

- **Hard purge — erasing a document rather than superseding it.** Deferred by decision, not by oversight: the write path is append-only, so "delete" today writes a revision marking the document gone and leaves every earlier revision in place. Real erasure has to find every surface the content and its derived vectors came to rest on, and the standing constraint on everything that lands before it is that nothing may add a new one. What exists today, and what deliberately does not: the revision rows every write path produces are the content surface, and a purge has to walk them; embeddings sit on those same rows, never shared across workspaces (the `prev` lookup in `ingestFile` is scoped by `workspace_id`, so two workspaces holding the same document each embed their own copy); keyset cursors are stateless, `encodeCursor`/`decodeCursor` (`packages/broker/src/sql/cursor.ts`) round-tripping a `{ v, f, d, k }` tuple through base64url with no cursor table and no server-side session to find; batch decisions and batch reads (`decideProposals`, `queryBatch`) add nothing on the content side beyond the revision and audit rows the single-item paths already wrote. [docs/events.md](events.md#8-hard-purge) covers why the same constraint rules out a content-bearing push channel.

- **Windows support for the CLI.** Development and testing happen on macOS and Linux: every CI job in `.github/workflows` runs on `ubuntu-latest`, and the agent tooling under `scripts/agent/` is POSIX. Nothing structural prevents Windows — the CLI is Node, and every child process is `execFileSync` with an argv array rather than a shell string, so there is no quoting layer to port. What is missing is a CI job and a pass over path handling in the bundle and Compose writers. The package-manager table in `packages/cli/src/cli-tools.ts` already lists `winget`, `scoop` and `choco` because that is the right shape for the table, **not** because the platform is supported.

- **Podman as the container engine for `warehousd start`.** Every subcommand the CLI issues is Docker's and Podman takes the same ones, so the gap was never argv — it is the places where a rootless container's view of the host differs. `buildRunArgs` in `packages/cli/src/docker.ts` writes `-v <host>:<container>` with no `:z`/`:Z` label, and `start` bind-mounts the project directory at `/project` for an image that runs as `USER node`; on an SELinux-enforcing host that mount is unreadable, and the uid needs `--userns=keep-id` or its equivalent. Publishing on `127.0.0.1` and the `--add-host host.docker.internal:host-gateway` that the local-database path adds both go through a network stack nothing here has run. A `server.runtime` key shipped once and was withdrawn: selectable-but-unverified put the choice in the file the whole product asks you to review in git, and answered "does this work?" with a footnote. It comes back with a CI job behind it — every workflow in `.github/workflows` runs `ubuntu-latest` with Docker today — and not before.
- **Declared indexes.** A dataset collection can name the fields it is queried by, and `warehousd apply` creates the index. See [docs/configuration.md](configuration.md#indexes).
- **Revision reads.** Reading a document as of a past revision, diffing two revisions, and reverting to one — all through the caller's current grant and postures.
- **Relations.** A field that composes the documents another collection holds, governed as fields of the host collection.

## Undecided

Not planned, not rejected — the shape of the answer is the open question.

- **Self-service catalogue authoring.** Adding a collection in production means editing `warehousd.yml`, rebuilding and redeploying, so an IT admin cannot self-serve and every new data source is an engineering ticket. Moving the config into the database would fix that and would discard the property that makes the product credible — that governance is reviewed in git. The direction we lean is the one `warehousd import map` already takes: the console *composes* a change and prints it for review, and `warehousd apply` stays the only thing that commits it. What is undecided is how far that goes — a diff view, a proposal loop with approvals, or nothing beyond what exists.

## Not planned

See [SECURITY.md](../SECURITY.md#out-of-scope) for what is deliberately out of scope, including the ones easily mistaken for gaps: distributed rate limiting, defence against a malicious administrator, and hostile-tenant isolation.

- **A message bus, or an event-driven core.** Evaluated in [docs/events.md](events.md#6-event-bus-the-verdict): embedding a Kafka producer would put delivery semantics and a hard dependency inside `packages/broker`, breaching the same "no dependency in the core" line `no-restricted-imports` already draws for HTTP, MCP and LLM imports, for no gain that analysis establishes. The recommendation for an operator who wants one anyway is to document a CDC recipe — Postgres logical replication plus Debezium — rather than build anything: it costs zero broker code and is explicit about what it yields, raw rows with no grant semantics, which is fine for a trusted warehouse landing zone and wrong for anything a grant is supposed to govern. A transactional outbox plus a pluggable relay is recorded as the shape a future build would take if the need ever outgrows that recipe, not as work planned now.

- **Hostile-tenant isolation.** Multi-workspace tenancy is real and database-enforced — RLS plus a view predicate on the data plane, RLS plus an explicit predicate on the control plane — but it serves *cooperative* tenants, not hostile ones. For a consuming application provisioning a workspace per customer, that means: one shared Postgres, so a workspace with a runaway query affects every other workspace's latency; no per-tenant rate limiting, so `/v1/token` and the query paths cap cost per process, not per workspace; and no noisy-neighbour protection, so nothing here reserves capacity for one tenant against another. A deployment that needs those guarantees puts them in front of warehousd — a proxy quota, per-tenant connection pools, or separate deployments — not inside it.
