# Changelog

All notable changes to warehousd are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) as described in
[docs/releasing.md](docs/releasing.md#versioning-policy).

One version number covers both published artifacts — the `warehousd` CLI on npm and the
`ghcr.io/tregismoreira/warehousd` server image — because `warehousd start` pulls the image tag
matching the CLI's own version. An entry below therefore describes both.

## [Unreleased]

### Security

- The credential endpoints refuse a request carrying an untrusted `Origin`. Better Auth's own
  `originCheck` guards only routes that carry a redirect target and validates that URL, so
  `trustedOrigins` was an open-redirect allowlist rather than a CSRF one: a cross-site
  form-encoded POST to `/api/auth/sign-in/email` returned 200 and a `Set-Cookie`, logging the
  victim into an account the attacker controls. Form-encoded posts are "simple requests" and get
  no CORS preflight, so nothing else stopped it. The SAML assertion callback is deliberately
  exempt — it is a legitimate cross-origin POST from the IdP.
- Session cookies are `Secure` on an https origin, `HttpOnly` and `SameSite=Lax` always, and the
  session lifetime is 8 hours rather than the default 7 days.
- Local credentials lock for 15 minutes after 5 failed attempts on one account within 15 minutes,
  refusing even the correct password for the duration. The existing limiters cap cost per IP and
  per client id, so a guess spread thinly across addresses tripped neither. Attempts against
  addresses that are not accounts are counted identically, so the lock cannot be used to
  enumerate users; failures outside the window do not accumulate, so occasional mistyping over
  months cannot add up to a lock; a stale row is collected on the next failed attempt, so
  spraying distinct addresses cannot grow the table without bound; and a lock is not extended by
  continued guessing, which would hand an attacker a denial of service against the owner.
- The MCP and REST query paths validate every client-supplied intent against a shared schema
  before any of it is read, closing a remotely-exploitable SQL injection through an aggregate
  function name. Refused intents are audited.
- Proposals can no longer be self-approved: a grant carrying both `update` and `approve` is
  refused with `self_approval_denied` when the approver is the proposer.
- A grant on `env: live` can no longer be approved by the person who requested it, for the same
  reason and with the same code. `dev` is exempt — its data is generated and regenerable.
- The approver's file-path picker is scoped to the approver's own organization. It read the
  default tenant's paths in every tenant.
- The LLM chat console has been removed rather than gated. It exposed a query surface in
  production that no configuration turned off.
- Token exchange binds the subject to a verified identity, requires `exp`, pins the signature
  algorithms, and caches issuer JWKS. Credential endpoints are rate-limited.
- A token carrying no environment scope is rejected at the resource rather than silently
  treated as `dev`.

### Changed

- The audit-failure log no longer carries a driver error's row values. Postgres reports them in
  the error's `DETAIL` field ("Key (home_address)=(...) already exists"), and that line logs the
  richest context the broker produces — it is the only remaining trace of a decision that went
  unrecorded. It now passes through a redaction helper that masks `detail`, `where` and
  `internalQuery` along with credentials, keeping the message so the constraint is still named.
- The adversarial probe corpus reaches the MCP surface. `surface: "mcp"` entries carry tool
  arguments rather than a broker intent, so they can forge the caller's `env`, `orgId` and
  `userId` — which the adapter derives from the token and the arguments must never influence. A
  new hostile argument shape is now a line of JSON rather than a new test.
- The adversarial probe harness captures raw `process.stdout` and `process.stderr` as well as
  `console.*`, and serialises object arguments before grepping them. It stringified them as
  `[object Object]`, so the canary assertions searched a string that could not contain a canary
  and passed whether or not a value had leaked.
- Every database statement is bounded by a `statement_timeout`, and connection acquisition by a
  `connectionTimeoutMillis`, so a stalled Postgres surfaces as a refusal rather than a hang.
- Read and write paths now agree about a grant's document filter for every declared field type.
- `listCollections` applies the client's collection ceiling.
- An audit write that fails becomes a controlled `internal_error` refusal instead of an
  unhandled exception with no audit row.

### Added

- **Documents can be uploaded from the console.** `/admin/documents` takes a multi-file selection
  or a whole folder, and is resumable: each file is hashed in the browser, `POST
  /api/admin/documents/plan` answers which of those hashes the collection already holds, and only
  the rest are uploaded — four at a time, retried on a transport failure. The resume is answered
  by the database rather than by anything the browser remembers, so an interrupted upload of a
  large corpus is resumed by picking the same folder again, from any machine. Deleting a document
  and downloading its original are admin-only and audited, as the upload is.
- Upload and `warehousd index` share one ingestion path (`indexing/ingest.ts`), so a document is
  indistinguishable downstream from one indexed off disk — same chunking, same checksum, same
  required-term rule. A new `origin` column keeps them apart for exactly one purpose: the index
  sweep mirrors a source directory, and must not delete a document that was never in one.
- `POST /api/admin/embed` and a console action beside it, for filling embeddings on a corpus that
  predates the `embedding:` block or a run a rate limit cut short.

- The admin console can look at data. `/admin/collections/{name}` gains a Data tab that browses a
  collection through `broker.query` / `broker.searchDocuments` with the session's own context, so
  an admin sees what their grants allow and every read is audited. A field legend distinguishes
  *denied by posture* from *grantable but not granted* from *granted*.
- `/admin/collections` is a searchable master/detail list grouped into datasets and file
  collections, with a document count per environment, per-row drift, and a route per collection.
  Field postures now render both axes, so "write denied" no longer looks like "not applicable".
- `/admin/taxonomies`: every vocabulary, its terms with per-environment document counts, whether
  it comes from the YAML or from a collection's rows, and which collections bind it.
- File collections have a Files tab listing the indexed files with their document counts. A
  `posture: deny` field such as `path` is absent unless the caller's own grant names it.
- The dev/live switcher now changes what the admin console shows — counts, terms, files, data and
  the audit filter's first-load default all follow it. `/admin/import` states that it always
  writes live regardless.
- `docs/connect-claude.md` covers connecting a local instance, including why `BETTER_AUTH_URL`
  must equal the tunnel URL.
- The generated `fly.toml` configures a Fly health check against `/api/health`. The deploy polled
  that endpoint once and then stopped looking, so nothing noticed a machine that wedged after a
  healthy release — it stayed in rotation.
- App-schema changes are versioned. Ordered migrations are applied under a Postgres advisory
  lock, each in its own transaction, and recorded in `app.schema_migrations` — replacing a single
  create-if-not-exists function that could express no change to an existing table. A failed
  migration rolls back and records nothing, so the Fly release command can abort a deploy and
  leave the previous release serving against a database it still understands.
- `pnpm typecheck` covers `test/`, `e2e/` and `scripts/` as well as `src` — previously ~16.7k
  lines of test code were type-checked nowhere.
- ESLint enforces rules for the first time, including `no-floating-promises` and
  `no-explicit-any`.
- Coverage measurement (`pnpm test:coverage`), merged across both test passes.
- CodeQL, Dependabot, `pnpm audit`, and SHA-pinned GitHub Actions.
- The test harness sweeps its own leftover databases instead of leaking one per suite per run.

[Unreleased]: https://github.com/tregismoreira/warehousd/commits/main
