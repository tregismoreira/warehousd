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

- Every database statement is bounded by a `statement_timeout`, and connection acquisition by a
  `connectionTimeoutMillis`, so a stalled Postgres surfaces as a refusal rather than a hang.
- Read and write paths now agree about a grant's document filter for every declared field type.
- `listCollections` applies the client's collection ceiling.
- An audit write that fails becomes a controlled `internal_error` refusal instead of an
  unhandled exception with no audit row.

### Added

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
- `pnpm typecheck` covers `test/`, `e2e/` and `scripts/` as well as `src` — previously ~16.7k
  lines of test code were type-checked nowhere.
- ESLint enforces rules for the first time, including `no-floating-promises` and
  `no-explicit-any`.
- Coverage measurement (`pnpm test:coverage`), merged across both test passes.
- CodeQL, Dependabot, `pnpm audit`, and SHA-pinned GitHub Actions.
- The test harness sweeps its own leftover databases instead of leaking one per suite per run.

[Unreleased]: https://github.com/tregismoreira/warehousd/commits/main
