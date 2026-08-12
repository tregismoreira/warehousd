# Changelog

Notable changes, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format and following [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as described in [docs/releasing.md](docs/releasing.md#versioning-policy).

One version number covers both published artifacts — the `warehousd` CLI on npm and the `ghcr.io/tregismoreira/warehousd` server image — because `warehousd start` pulls the image tag matching the CLI's own version. An entry below describes both.

## [Unreleased]

## [0.1.0-rc.1] - 2026-08-11

The first release candidate, and the first artifact this repository publishes at all — nothing precedes it on npm or ghcr.io. The categories below are therefore not a delta from an earlier version.

**Not meant for production.** No external security audit, no production deployment behind it. Interfaces can change between release candidates, and no upgrade path is guaranteed. Bug reports welcome; vulnerabilities privately, per [SECURITY.md](SECURITY.md).

Component status is tracked in the [README](README.md#component-status). Four entries are not `real` here: multi-tenancy is *partial* (data is isolated per org, but one org is created at bootstrap and there is no UI to add or switch), Supabase database provisioning is *partial* and Neon `real`, podman is selectable and checkable but unverified, and SCIM and compliance exports are *not built*.

Publishing goes to npm's `next` dist-tag and, until a stable release exists, to `latest` as well; the `:latest` image tag is left alone. See [docs/releasing.md](docs/releasing.md#the-exception-before-the-first-stable-release). Per the [versioning policy](docs/releasing.md#versioning-policy) a minor bump before 1.0.0 may break compatibility, and each one is recorded under **Changed**.

### Security

- The credential endpoints refuse a request carrying an untrusted `Origin`. Better Auth's `originCheck` guards only routes with a redirect target, so a cross-site form-encoded POST to `/api/auth/sign-in/email` returned a `Set-Cookie` and logged the victim into an attacker's account. The SAML assertion callback is exempt — it is a legitimate cross-origin POST from the IdP.
- Session cookies are `HttpOnly` and `SameSite=Lax` always and `Secure` on an https origin, and a session lasts 8 hours rather than the default 7 days.
- Local credentials lock for 15 minutes after 5 failed attempts on one account within 15 minutes. Addresses that are not accounts are counted identically so the lock cannot enumerate users, stale rows are collected on the next failure, and continued guessing does not extend a lock.
- The MCP and REST query paths validate a client-supplied intent against a shared schema before reading any of it, closing a remotely-exploitable SQL injection through an aggregate function name. Refused intents are audited.
- Proposals can no longer be self-approved: a grant carrying both `update` and `approve` is refused with `self_approval_denied` when the approver is the proposer.
- A grant on `env: live` can no longer be approved by the person who requested it. `dev` is exempt — its data is generated and regenerable.
- The approver's file-path picker is scoped to the approver's own organization. It read the default tenant's paths in every tenant.
- The LLM chat console is removed rather than gated. It exposed a query surface in production that no configuration turned off.
- Token exchange binds the subject to a verified identity, requires `exp`, pins the signature algorithms, and caches issuer JWKS. Credential endpoints are rate-limited.
- A token carrying no environment scope is rejected at the resource rather than treated as `dev`.

### Changed

- **Every human run of the CLI is one connected frame**: `┌` on the command's name, a `│` rail down the left, `└` on a sentence saying what to do next. Off a terminal — piped, redirected, in CI, under `--json` — there is no frame and no rail, and the stdout/stderr split is unchanged.
- `start`, `restart` and `deploy` end on the full onboarding block: what happened, what to run next, the everyday commands, and the docs link.
- One meaning per glyph and colour in every command: `◇` done, `▲` caution, `■` failure, cyan for somewhere to go, bold accent for something to type. Concept icons sit beside a label on a terminal and are dropped off one rather than faked in ASCII.
- Step lines read as sentences — `◇  [1/7]  Checked docker — version 29.6.2` — and a step with a known total draws a `█░` bar and a percentage instead of a spinner.
- A bare `warehousd` and `warehousd --help` print a grouped, example-led screen rather than commander's alphabetical dump. Global flags stay on the per-command `--help`.
- A failure ends on a `└` line saying what to do about it, and an error that is a bug rather than a condition in the world carries the issue-tracker URL.
- The release-candidate notice always has a blank line above and below it.
- `warehousd import map` prints the proposal on stdout and everything it says *about* the proposal on stderr, so `warehousd import map people.csv >> warehousd.yml` no longer appends prose to a YAML file.
- A backticked command in prose is drawn in the type colour instead. The backticks stay wherever colour is off (`NO_COLOR`, `--no-color`, `TERM=dumb`, a pipe), where they are the only thing marking the span as something to type.
- `--db-provider` now means "create the database there"; `--attach-db` means "who hosts the url I am about to supply".
- `deploy.database.provider` is no longer refused without a `url`.
- `deploy.region` is a target pre-flight check (`fly-region`, `railway-region`) rather than a three-letter slug in the schema, so `us-west2` can be expressed and a bad code is refused by the target that knows its own.
- The deploy summary names the target it deployed to, and how to reach a database it did not print a URL for. Both used Fly's wording on every target.
- The `app_name` validation message no longer names Fly. The constraint is a DNS label, which every target shares.
- `warehousd doctor --deploy` runs the deploy pre-flight without deploying — previously unreachable outside `warehousd deploy`. Opt-in, because it dials the production database and the target's CLI. Nothing mutates.
- `warehousd init` asks about the local database and the production one separately, so "Docker locally, Supabase in production" can be scaffolded. One shared answer used to rewrite the *local* `database:` block too.
- `warehousd deploy --json` carries the target's id and label, its database hint and its notes. A Compose deploy's "nothing is running yet" survived `--quiet` but `--json` returned before anything read it.
- `--destroy` asks the target what it is about to do, instead of promising to destroy a machine Compose does not control.
- The audit-failure log redacts `detail`, `where` and `internalQuery` from a driver error, which quoted the values of the failing document. The message survives, so the constraint is still named.
- The adversarial probe corpus reaches the MCP surface. A `surface: "mcp"` entry carries tool arguments rather than a broker intent, so it can try to forge the caller's `env`, `orgId` and `userId`.
- The adversarial probe harness captures raw `process.stdout` and `process.stderr` as well as `console.*`, and serialises object arguments before grepping them. It stringified them as `[object Object]`, so the canary assertions passed whether or not a value had leaked.
- Every statement is bounded by a `statement_timeout` and connection acquisition by a `connectionTimeoutMillis`, so a stalled Postgres surfaces as a refusal rather than a hang.
- Read and write paths agree about a grant's document filter for every declared field type.
- `listCollections` applies the client's collection ceiling.
- A failed audit write becomes a controlled `internal_error` refusal instead of an unhandled exception with no audit row.

### Added

- **`deploy.target` — `fly | railway | compose`.** Each target is a `DeployTarget` behind a registry, so nothing outside `packages/cli/src/deploy/targets` branches on a target id. `fly` remains the default.
  - **Railway.** `railway init`/`add`, a generated `railway.json` carrying the health check and `deploy.region`, and `railway up --detach`. Railway has no `release_command`, so the image's own CMD bootstraps and then serves in one container. `railway variables --set K=V` passes values in argv; `--verbose` redacts them and [docs/deploy-railway.md](docs/deploy-railway.md) states the residual exposure.
  - **Docker Compose.** Renders `docker-compose.deploy.yml` and a mode-0600 env file, and starts nothing — the stack runs on a machine this command does not control. No secret appears in the compose file, `/project` is read-only, and the server is published on loopback.
- **`deploy.database.provider` — `supabase | neon | railway | generic`.** Role URLs come from a provider registry rather than a swapped username: on Supabase's pooler the username carries the project ref, so a bare role name authenticates as nobody. The key overrides a host that does not advertise who runs it; otherwise the hostname decides.
- `deploy.database` takes `managed: true` alongside `provider: supabase` or `provider: neon`, creating the database through that provider's CLI, recording it in `.warehousd/state.json` so a redeploy reconnects, and deleting it on `--destroy`. `deploy.database.region` and `deploy.database.org` go with it. See [docs/deploy-database.md](docs/deploy-database.md).
- **Deploy pre-flight probes the target database** before an image is built: `db-reachable`, `db-can-create-role`, `db-extensions`, `db-search-path` and `db-provider`. They are read-only, and they ask about *inherited* privilege and about capability rather than about the roles that happen to exist — so Neon's `neondb_owner` is answered correctly, and so is a database that has never booted.
- `database.provider` on the top-level block runs a provider's local stack instead of the built-in `pgvector` container. Supabase's reproduces the hosted product's `extensions` schema, which is where a class of masked-read failure used to hide until production.
- `warehousd init` asks whether to set up guided or manually, and in guided mode checks every CLI the answers need — offering to install a missing one through whichever of `brew`, `npm`, `apt-get`, `dnf`, `pacman`, `winget`, `scoop` or `choco` this machine has. It never installs without confirmation or `--install-missing`, and never runs `sudo`. New flags: `--runtime`, `--local-db`, `--db-region`, `--db-org`, `--attach-db`, `--manual`, `--install-missing`.
- `warehousd init --target <id>` and `--db-provider <id>` scaffold a `deploy:` block non-interactively, with a region the target actually has.
- `server.runtime` selects the container engine: `docker` (default) or `podman`.
- `start` proves the password in `.warehousd/state.json` opens the database before starting the server, when that database is the built-in container.
- Long commands number their steps — `[4/9] Creating …`.
- **Per-document ACLs.** A collection declaring `acl: true` gets a rule grant filters cannot express: a document with no ACL is readable by anyone the grant covers, and a document with an ACL only by the principals it lists. An ACL never widens a grant. Principals are `user:<id>` / `group:<name>`, resolved against `app.user_groups` from the caller's id on every request, never from a token.
- The ACL is one clause ANDed into the `WHERE` every read already builds, so it lands inside the hybrid `scoped` CTE and inside every aggregate — a `count` returns what the caller may see. The write path reads base tables instead, so the eight in-process filter checks now go through a single `admits()` that fails closed when the ACL column was not fetched. `packages/broker/test/acl-parity.test.ts` asserts the two evaluators agree against a live Postgres.
- ACLs are edited through `GET`/`PUT`/`DELETE /v1/collections/{c}/documents/{id}/acl` or the console's **Access** tab, and deliberately not over MCP. Managing one takes the `manager`/`admin` console role or a client policy carrying `can_manage_acl`, read by the broker itself so an adapter cannot assert it. Both verbs are audited, and `app.audit_events.principals` records the membership each decision ran under.
- `can_manage_acl` is granted per client in **Admin → Clients**, admin-only and on its own axis: it is not a scope, does not travel in a token, and promoting a client to `env:live` neither grants nor implies it.
- ACLs are for dataset collections only in v1. `acl: true` requires a declared primary key and is refused on file and connect-in-place collections. `_acl` is reserved as a field name.
- An SSO login persists the asserted group list to `app.user_groups`. Console-pinned memberships (`source: 'manual'`) survive a re-sync, and an assertion with no group claim changes nothing. An `app.sso_provisioned` marker keeps role provisioning a first-login act, so membership can sync every login without undoing a console promotion. `GET`/`PUT /api/admin/users/{id}/groups` manages the manual source.
- `examples/harbor` turns ACLs on for `announcements`, so the Playwright suite can restrict one announcement in the console and watch a headless key's count drop by exactly one.
- **Documents can be uploaded from the console.** `/admin/documents` takes a multi-file selection or a whole folder and is resumable: each file is hashed in the browser, `POST /api/admin/documents/plan` answers which hashes the collection already holds, and only the rest upload — four at a time, retried on a transport failure. The resume is answered by the database, so an interrupted upload continues from any machine. Deleting a document and downloading its original are admin-only and audited.
- Upload and `warehousd index` share one ingestion path (`packages/broker/src/indexing/ingest.ts`), so a document is indistinguishable downstream from one indexed off disk. A new `origin` column keeps them apart for one purpose: the index sweep mirrors a source directory and must not delete a document that was never in one.
- `POST /api/admin/embed` and a console action beside it, for filling embeddings on a corpus predating the `embedding:` block or a run a rate limit cut short.
- `/admin/collections/{name}` gains a Data tab that browses a collection through `broker.query` / `broker.searchDocuments` with the session's own context, so an admin sees what their grants allow and every read is audited. A field legend distinguishes *denied by posture* from *grantable but not granted* from *granted*.
- `/admin/collections` is a searchable master/detail list grouped into datasets and file collections, with a document count per environment, drift, and a route per collection. Field postures render both axes, so "write denied" no longer looks like "not applicable".
- `/admin/taxonomies`: every vocabulary, its terms with per-environment document counts, whether it comes from the YAML or from a collection, and which collections bind it.
- File collections have a Files tab listing indexed files with their document counts. A `posture: deny` field such as `path` is absent unless the caller's grant names it.
- The dev/live switcher changes what the admin console shows — counts, terms, files, data and the audit filter's default. `/admin/import` states that it always writes live regardless.
- App-schema changes are versioned: ordered migrations under a Postgres advisory lock, each in its own transaction, recorded in `app.schema_migrations`. A failed migration rolls back and records nothing, so a release command can abort a deploy and leave the previous release serving.
- The generated `fly.toml` configures a Fly health check against `/api/health`, so a machine that wedges after a healthy release leaves rotation.
- [docs/connect-claude.md](docs/connect-claude.md) covers connecting a local instance, including why `BETTER_AUTH_URL` must equal the tunnel URL.
- **`packages/cli/test/e2e/surface.e2e.test.ts` and `pnpm test:e2e:cli:surface`.** The whole command surface driven as a subprocess against the built bundle, with no container, database or network — about ten seconds. It asserts all three renderings: piped (flat, ASCII, no escape byte), a terminal with colour off, and a terminal with 24-bit colour. `program.ts` is excluded from coverage because every export in it is an argv-driven action callback.
- A release is gated on a full CI run. `release.yml` opens the GitHub Release as a draft, calls `ci.yml` against the tagged commit, and publishes the image, the npm package and the release only once every job is green. A tag previously matched neither of `ci.yml`'s triggers.
- `pnpm typecheck` covers `test/`, `e2e/` and `scripts/` as well as `src` — previously ~16.7k lines of test code were type-checked nowhere.
- ESLint enforces rules for the first time, including `no-floating-promises` and `no-explicit-any`.
- Coverage measurement (`pnpm test:coverage`), merged across both test passes.
- CodeQL, Dependabot, `pnpm audit`, and SHA-pinned GitHub Actions.
- The test harness sweeps its own leftover databases instead of leaking one per suite per run.

### Fixed

- A database volume that outlives its `.warehousd/state.json` is refused in about two seconds, naming the volume, the state file and `warehousd stop --destroy`. Postgres takes `POSTGRES_PASSWORD` only from an empty data directory, while the volume name is global and the state file is per-directory and gitignored — so deleting that file, or starting the same project from a second checkout, handed the server a password the database never had. It used to present as a 180-second health-check timeout blaming the config or an unreachable database.
- `warehousd logs`, and the excerpt `start` prints when the health check fails, carry the container's **stderr**. The helper returned only stdout, so every line a Node process writes when it dies was dropped — the `Container logs:` block printed empty in exactly the situation it exists to explain.
- The deploy health poll requested `/api/health/api/health` and timed out for three minutes against an app that was serving. The endpoint was appended twice.
- A first Railway deploy no longer fails at `railway domain`. The domain is generated before the deploy because `BETTER_AUTH_URL` has to be in the secrets the release reads, so the container port is now passed explicitly rather than inferred from a deployment that does not exist yet, and the `--json` body is preferred over the printed line.
- A first Railway deploy no longer refuses over a database that is still provisioning. `railway add --database postgres` returns when the request is accepted, not when the database exists, so its `DATABASE_URL` read empty on the happy path. The read is retried for up to 30s.
- `warehousd deploy --destroy` on Fly can tear down a half-provisioned deploy. Destroying the app threw when there was no app and never reached the database app, leaving the expensive half standing.
- A hosted Postgres that installs its extensions outside `public` now works. Supabase ships pgcrypto in a schema called `extensions`, making `create extension if not exists pgcrypto` a silent no-op and leaving every unqualified reference unresolvable for the data roles — apply and boot both succeeded, and the first masked read or semantic search failed at request time as an `internal_error`. `applyConfig` reads back where `vector`, `pgcrypto` and `postgres_fdw` landed and puts that schema on the roles' `search_path`, scoped to the one database.
- The boot wait for Postgres no longer leaks a connection pool per failed attempt. It ended one only on success, so a 60s wait at 500ms intervals left up to 120 dangling.

[Unreleased]: https://github.com/tregismoreira/warehousd/compare/v0.1.0-rc.1...HEAD
[0.1.0-rc.1]: https://github.com/tregismoreira/warehousd/releases/tag/v0.1.0-rc.1
