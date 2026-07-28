# Testing

For contributors — [CONTRIBUTING.md](../CONTRIBUTING.md) gets the repository
running first.

Every security invariant in [architecture.md](architecture.md) has a test. If you
change enforcement, the pull request must carry a test that fails without it.

## The suites

| Command | What it runs | Needs |
|---|---|---|
| `pnpm lint` | ESLint, including the rule that keeps `packages/broker` free of HTTP/MCP/UI/LLM imports | — |
| `pnpm test` | Vitest: broker unit + integration, CLI, and web route/integration tests | Postgres |
| `pnpm build` | Production build and full typecheck | — |
| `pnpm e2e` | Playwright against a real browser: all eleven web surfaces | Postgres |
| `pnpm test:e2e:cli` | The built CLI driving real Docker containers end to end | Docker |
| `pnpm test:e2e:sso` | A real OIDC and SAML round trip against Keycloak | Docker |
| `pnpm test:e2e` | Both of the above, in sequence | Docker |

Postgres comes from `pnpm test:up` (pgvector on `127.0.0.1:54330`, plus Keycloak
for the SSO suite); `pnpm test:down` tears it down with its volume.

```bash
pnpm test:up
pnpm lint
WAREHOUSD_PROJECT_DIR=examples/meridian pnpm test
pnpm build
pnpm e2e
pnpm test:down
```

**`pnpm test` does not typecheck.** Vitest transpiles without checking, so type
errors sit undetected while every test passes. `pnpm build` is what catches them;
`npx tsc --noEmit -p apps/web/tsconfig.json` lists them all at once, where
`next build` reports only the first.

The Keycloak suite is gated behind `WAREHOUSD_E2E_KEYCLOAK`, so a default
`pnpm test` run never needs a container beyond Postgres. `pnpm test:e2e:cli`
runs the *built* CLI against real containers and takes several minutes — run
`pnpm --filter ./packages/cli build` first (a path filter, not a name filter:
`warehousd` also matches the private root package), and point it at a locally
built image with `WAREHOUSD_IMAGE=warehousd:ci`.

> ⚠️ **Free port 8722 before running `pnpm e2e`.** `playwright.config.ts` sets
> `reuseExistingServer: !process.env.CI`, so if anything is already serving
> `http://localhost:8722/login` — most easily a container left behind by
> `warehousd start` or a previous `test:e2e:cli` run — Playwright silently reuses
> it instead of starting the dev server under test. The suite then runs against
> the wrong database and fails with `WARN [Better Auth]: User not found` and
> sign-in timeouts that look like application bugs. Check with
> `lsof -nP -iTCP:8722 -sTCP:LISTEN` before debugging anything else.

CI runs lint, `pnpm test`, and `pnpm build`, then Playwright, a packaging
smoke test that installs the CLI tarball outside the workspace, and the CLI and
SSO end-to-end suites.

## What the enforcement tests assert

The interesting ones, and where they live:

- **Broker-only path** (`packages/broker/test/db-roles.test.ts`) — the app's role
  gets a permission error selecting from `data_live` / `data_synth` directly,
  while the same read through the broker succeeds.
- **Adversarial leak probe** (`packages/broker/test/probe.test.ts`, driven by
  `fixtures/probes.json`) — hostile intents: denied fields in filters, `orderBy`
  and `in`-lists, oversized limits, unknown-field probing, SQL fragments inside
  string values, shape fuzzing. Denied canary values are planted in the seed data
  and grepped for across response bodies, error messages, and logs. New hostile
  intents are added to the JSON, not to code.
- **Deny by default and field enforcement** (`broker-query`, `grant-eval`) — a
  user with no grant gets `no_grant` everywhere but still sees names and
  descriptions from `list_collections`; a grant excluding `email` makes the key
  *absent* from every returned document, not null.
- **The dev/live wall** (`db-roles`, `probe`) — exhaustive dev-token queries
  return zero hits on live-only canaries, and `warehousd_dev` gets a permission
  error on `data_live.v_people`.
- **Scope escalation** (`apps/web/test/oauth-scope.integration.test.ts`) — a
  dev-only client requesting `env:live` receives a token containing only
  `env:dev`; after promotion the next refresh carries `env:live`; after demotion
  it drops again.
- **Grant lifecycle** (`grant-lifecycle`) — request → approve with trimmed fields
  → query succeeds → revoke → the *immediately next* query returns `no_grant`,
  with no token refresh involved. Expired behaves as revoked.
- **Aggregation** (`aggregation`) — correct values under a grant that covers the
  field; `field_denied` when it does not, asserted for the field appearing in
  `aggregate`, in `groupBy`, and in `filters`; `invalid_intent` when `aggregate`
  and `fields` are combined.
- **Document and term scoping** (`document-paths`, `taxonomy-grants`) — scoped
  documents are silently absent, bypass probes leak nothing, an empty `in` list
  denies everything, and a second approved grant is refused by the unique index.
- **Tenant isolation, data plane** (`org-isolation`) — two orgs' documents in one
  collection; each org's query returns only its own. The proof that *the database*
  is what refuses: the SQL `buildSelect` produced is asserted to contain no
  `org_id`, then run directly against the view under each org, and it still
  separates the rows. With no org in scope the view returns nothing — the wall
  fails closed.
- **Tenant isolation, control plane** (`org-control-plane`) — `app.grants` has no
  view or RLS policy behind it, so each decision function carries the predicate:
  a manager cannot approve, deny or revoke another org's grant, an omitted org
  fails closed rather than open, and `env:live` eligibility does not leak across
  orgs for the same user id.
- **Two-axis postures** (`postures-two-axis`) — a bare `allow` normalizes to
  read-allow/write-deny, so no pre-existing config becomes writable; `view_join`
  plus `write: allow` is a config error; a posture stored in the old bare-string
  form still reads back correctly.
- **Verbs** (`verbs`) — existing grants default to `['read']`; a grant without
  `read` refuses with `no_grant` rather than a distinguishable code; `approve`
  without `read` is rejected at approval time; `update` on a file collection is
  rejected structurally; an append-only `create` grant with no `read` is valid.
- **`$self` filters** (`self-filter`) — the sentinel binds to the caller, resolves
  per element inside an `in` list, `$self-service` stays a literal, and the
  generated SQL never contains the string `$self`.
- **Dataset search** (`searchable`) — `searchable: true` makes a dataset reachable
  from `search_documents`, a non-searchable field on the same collection is not
  matched, and the generated `<field>_tsv` column never appears in
  `describe_collection` or in `fieldsReturned`.
- **Revision storage** (`revisions-ddl`) — a `writable` dataset gets `_rev*` and
  the partial unique index, and its declared pk stops being the primary key; a
  second *current* revision for one document is rejected by the database while a
  non-current one is accepted, which is what lets proposals coexist; the view
  hides superseded and tombstoned revisions while the history stays in the table;
  a non-writable dataset gains none of it; turning `writable: true` on over an
  existing plain table fails the apply.
- **Immutability by privilege** (`write-privileges`, against real Postgres) — the
  write role *cannot* UPDATE a data column and *cannot* DELETE, asserted as
  Postgres errors and again against `information_schema`; it *can* insert and
  update `_current`/`_rev_status`; RLS confines its base-table SELECT to one org.
- **Full-document reads** (`get-document`) — only granted fields come back; a
  document the filter excludes is `not_found`, the same answer as one that does
  not exist; `$self` scopes it; `path` on a dataset is `invalid_intent`; a file's
  chunks are rejoined into one document rather than returning the first chunk;
  `org_id` and `_rev*` never appear; every outcome writes an audit row.
- **Mutation refusals** (`mutate-refusals`) — one test per reason code, plus the
  leak assertion: no refusal body contains a submitted field name, a submitted
  value, or SQL, checked by stringifying the whole result and grepping.
- **Dataset writes** (`mutate-dataset`) — create appends `_rev_seq=1` and is
  readable through `query`; update appends a new revision, demotes the old, and
  carries untouched columns forward; delete leaves a tombstone that is absent
  from reads but present in the table; a stale `expect` is `conflict`; a `$self`
  filter blocks editing someone else's document; the audit row names the fields
  touched and never their values.
- **File writes** (`mutate-file`) — create inserts a file row plus its chunks and
  the result is immediately searchable; a duplicate `path` is `conflict`, decided
  by the unique index rather than a pre-check the write role has no privilege to
  make; `update`/`delete` are `verb_not_supported` even with those verbs granted.
- **Write env isolation** (`mutate-env-isolation`) — a dev context reaches only
  the dev write pool, and with no write pool configured `mutate` returns
  `not_writable` rather than throwing.
- **Audit completeness** (`audit`) — every outcome above writes an event, and the
  audit role cannot UPDATE or DELETE.
- **Fabrication guard** (`apps/web/test/mcp-tools.test.ts`, `console-gate`) — a
  model pressed for data it has no grant for does not get to present invented
  numbers as an answer.

## What is still manual

The Playwright suite covers all eleven web surfaces. Three things are still
checked by hand, because they need credentials or a product UI no test can drive:

1. **Connecting a real assistant.** [connect-claude.md](connect-claude.md) — add
   the connector in Claude, complete the OAuth flow, confirm it lands on the
   IdP's login page, run `list_collections`, and probe a denied field.
2. **A real IdP.** [configure-sso.md](configure-sso.md) against Okta, Entra ID,
   or Google Workspace rather than the Keycloak container the automated suite
   uses.
3. **The login page's SAML branch, and how any of it looks.**
   `apps/web/e2e/login.spec.ts` now drives the page's states by mocking
   `/api/sso/status` — SSO-first rendering with local login collapsed, the "No
   login method is configured" state, and `returnTo` parameters surviving
   sign-in through to the authorize endpoint. Two gaps remain: no test sends
   `providerType: "saml"`, and no test asserts what the page *looks* like. Check
   those by eye against a registered SAML provider.

Re-run all three whenever the OAuth flow, the login page, or the env-scope rules
change materially — they are the only checks that exercise the full chain the way
a user experiences it.
