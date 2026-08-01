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
- Local credentials lock for 15 minutes after 5 failed attempts on one account, refusing even the
  correct password for the duration. The existing limiters cap cost per IP and per client id, so
  a guess spread thinly across addresses tripped neither. Attempts against addresses that are not
  accounts are counted identically, so the lock cannot be used to enumerate users, and a lock is
  not extended by continued guessing — that would hand an attacker a denial of service against
  the account's owner.
- The MCP and REST query paths validate every client-supplied intent against a shared schema
  before any of it is read, closing a remotely-exploitable SQL injection through an aggregate
  function name. Refused intents are audited.
- Proposals can no longer be self-approved: a grant carrying both `update` and `approve` is
  refused with `self_approval_denied` when the approver is the proposer.
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
