# Testing

For contributors — [CONTRIBUTING.md](../CONTRIBUTING.md) gets the repository
running first.

Every security invariant in [architecture.md](architecture.md) has a test. If you
change enforcement, the pull request must carry a test that fails without it.

## The suites

| Command | What it runs | Needs |
|---|---|---|
| `pnpm lint` | ESLint, including the rule that keeps `packages/broker` free of HTTP/MCP/UI/LLM imports | — |
| `pnpm typecheck` | `tsc` over four projects: `src`, `test`, `e2e` and `scripts` | — |
| `pnpm format:check` | Prettier, code only — prose is out of scope (see `.prettierignore`) | — |
| `pnpm test` | Vitest: broker unit + integration, CLI, and web route/integration tests | Postgres |
| `pnpm test:coverage` | `pnpm test` with coverage merged across both passes, checked against a floor | Postgres |
| `pnpm build` | Production build and full typecheck | — |
| `pnpm e2e` | Playwright against a real browser: every web surface | Postgres |
| `pnpm test:e2e:cli` | The built CLI driving real Docker containers end to end | Docker |
| `pnpm test:e2e:sso` | A real OIDC and SAML round trip against Keycloak | Docker |
| `pnpm test:e2e` | Both of the above, in sequence | Docker |

Postgres comes from `pnpm test:up` (pgvector on `127.0.0.1:54330`, plus Keycloak
for the SSO suite); `pnpm test:down` tears it down with its volume.

### How the browser suite signs in

`pnpm e2e` runs two Playwright projects. `setup` (`apps/web/e2e/auth.setup.ts`) signs each of the
three personas in through the login form once and saves its cookies under `apps/web/e2e/.auth/`;
`e2e` declares it as a dependency, so the sessions are there however far down you filter the run.
Specs then call `as(page, "manager")`, which swaps the stored jar into the browser context rather
than driving the form. Nearly every test signs in only in order to *be* someone, and the form costs
a page load, a POST and a password hash every time — that was the bulk of the suite's runtime.

Two things follow, and both matter before you write a spec:

- **The session is shared for the whole run.** `signOut()` revokes it server-side, so calling it
  after `as()` breaks every later test that wanted that persona. Switch persona by calling `as()`
  again — it clears cookies first, so nothing of the previous one survives. `as()` fails loudly,
  naming the persona, if the jar it loads is no longer accepted.
- **That signing in works at all is `login.spec.ts`'s subject**, not a side effect of the other
  fourteen files. It signs in for itself, which is why it is also the one file that may sign out.

```bash
pnpm test:up
pnpm lint
pnpm typecheck
pnpm format:check
WAREHOUSD_PROJECT_DIR=examples/harbor pnpm test
pnpm build
pnpm e2e
pnpm test:down
```

## Template databases

`pnpm test` used to bootstrap every test database from scratch: schemas, roles, the app
schema, a `@better-auth/cli migrate` subprocess and three persona signups, forty times over.
That work is identical every time, so `vitest.global-setup.ts` does it once into three
template databases and each test copies one with `create database … template …`, which is a
file copy.

- `wh_tmpl_broker_<suffix>` — schemas, grants and the cluster-global data roles.
- `wh_tmpl_web_<suffix>` — the above plus the app schema, the Better Auth migration and the
  three personas. Built by `bootstrapWebDb` in `apps/web/test/helpers/web-db.ts`.
- `wh_tmpl_web_data_<suffix>` — layered on the previous one, plus the whole harbor example:
  config, synthetic data, live seed and the file-collection indexes.

The `<suffix>` is a hash of the checkout path. Databases are cluster-global and sibling
workspaces share this Postgres, so without it one workspace's globalSetup would drop the
template another one is mid-run cloning from — the same destructive failure described under
"Running two checkouts at once" below.

Templates are **left in place between runs**, so a second `pnpm test` skips the bootstrap
entirely. They rebuild when a hash of `packages/broker/src/**`, `apps/web/lib/**`,
`examples/harbor/**` and `pnpm-lock.yaml` changes — the whole of `apps/web/lib` because
`oauth.ts` and `sso.ts` decide which tables the Better Auth migration creates. To force it:

```bash
WAREHOUSD_TEST_REBUILD_TEMPLATES=1 pnpm test
```

Because nothing else drives the bootstrap against an empty database any more,
`apps/web/test/entrypoint-bootstrap.integration.test.ts` does — calling the same
`bootstrapWebDb` the template is built from, so the two cannot drift. `bootstrap.test.ts`
likewise provisions a bare database rather than a copy of the template.

`pnpm test` runs in two passes: `test:parallel` (every file, four workers) then `test:serial`.
`WAREHOUSD_TEST_WORKERS` changes the worker count — it defaults to 4 because sibling
workspaces share this machine.

Arguments are forwarded, so `pnpm test change-feed` and
`pnpm test packages/broker/test/types.test.ts --reporter=verbose` both work. That needs
`scripts/run-tests.ts` rather than a `&&` chain: pnpm hands trailing arguments to the *last*
command in a chain, so a filter would have run the parallel pass unfiltered and then failed the
serial one on a name it could never match. The wrapper sends a filter to whichever pass owns
the file.

Two suites are in the serial pass, both because they assert on state that is global to the
Postgres *cluster* rather than to their own database:

- `bootstrap.test.ts` rotates the `warehousd_dev` password to prove the escaping round-trips.
  Roles are cluster-global, so a parallel worker's pool hits that window and fails with
  `password authentication failed`.
- `change-feed.test.ts` expects an entry to be readable immediately after the write. The feed
  holds a row back until `pg_snapshot_xmin` passes its `xmin`, which is what stops `seq` from
  being handed out non-monotonically (see `changes` in
  `packages/broker/src/verbs/history.ts`). Transaction ids are cluster-global, so an open
  transaction in *any other database on the same server* keeps that watermark below the new row
  and the feed correctly returns nothing yet. Worth knowing beyond
  the tests: change-feed latency depends on the busiest writer in the cluster, not just on this
  application.

Adding a suite that asserts on roles, transaction ids, or anything else outside its own
database means adding it to `SERIAL_TESTS` in `vitest.config.ts`.

**`pnpm test` does not typecheck** — vitest transpiles without checking, so a type
error sits undetected while every test passes. `pnpm typecheck` is what catches
it, and it covers more than `pnpm build` does: `scripts/typecheck.ts` runs `tsc`
over four projects, adding `test/`, `e2e/` and `scripts/` to the `src` that
`next build` and the broker's own build already cover. Those directories were
inside no program at all until then — 436 type errors and four latent bugs were
sitting behind a green suite, including three imports that resolved to
`undefined` at runtime and a Jest-ism (`expect(x).toBe(0, "message")`) whose
message vitest silently discarded.

Not `tsc -b`: build mode requires every project to be `composite`, and composite
forbids `noEmit`. Three of the four exist only to be checked.

### Per-run databases are swept, not leaked

Each test file provisions its own database — `wh_<label>_<checkout-suffix>_<pid>`,
cloned from a template — and its `afterAll` drops it. That covers the happy path
only: an interrupted run, a killed worker, an OOM, or a `beforeAll` that throws
after `provision()` returned all leave the database behind. Nothing collected
them, so they accumulated across every run anyone had ever done. Measured once:
**218 databases, of which 211 were abandoned clones holding 1.68 GB**, with idle
autovacuum on them costing the container ~27% CPU — 0.06% after dropping them.

`vitest.global-setup.ts` now sweeps at both ends. `teardown()` handles the
ordinary case including a suite that threw; `setup()` sweeps *before* the run,
because teardown cannot run at all if the run was killed, and that is what makes
the leak self-healing rather than dependent on remembering a command.

Two things bound the sweep, and both matter:

- **The checkout suffix is in the clone name.** Sibling workspaces share this
  Postgres, so "drop every `wh_%` that is not a template" would destroy another
  workspace's in-flight databases. The suffix is what makes a sweep addressable
  to one checkout. Templates end in the suffix too, so they match the pattern and
  are excluded by explicit name instead — losing one is a silent full rebuild.
- **A live owning pid is skipped.** The suffix scopes to a checkout, not to a
  process, and `pnpm test` is two vitest passes with nothing stopping a third run
  overlapping. The pid sits second-to-last in the name, ahead of the suffix, and
  is checked for liveness first.

`pnpm test:clean` does the same sweep by hand. It is the least important part of
this: a cleanup command nobody remembers to run is how it reached 211.

The Keycloak suite is gated behind `WAREHOUSD_E2E_KEYCLOAK`, so a default
`pnpm test` run never needs a container beyond Postgres. `pnpm test:e2e:cli`
runs the *built* CLI against real containers and takes several minutes — run
`pnpm --filter ./packages/cli build` first (a path filter, not a name filter:
`warehousd` also matches the private root package), and point it at a locally
built image with `WAREHOUSD_IMAGE=warehousd:ci`.

> ⚠️ **The write path needs its own two database URLs.** `DEV_WRITE_DATABASE_URL`
> and `LIVE_WRITE_DATABASE_URL` point at the `*_write` roles, which are the only
> ones holding `INSERT`/`UPDATE` on the base tables — the read roles see just the
> views. Omit them and `writePool` is null, so every mutation refuses with
> `not_writable` and the write specs fail in a way that looks like a grant
> problem. They are set in `playwright.config.ts` alongside the read URLs; any
> harness that starts the app itself must set them too.

> ⚠️ **Recreate Keycloak after editing `test/keycloak/warehousd-realm.json`.** The
> realm is imported at container start, so `pnpm test:up` leaves an already-running
> container serving the old one. `pnpm test:e2e:sso` then fails inside Keycloak's
> login form — `expected 200 to be greater than or equal to 300`, or `Could not
> find SAMLResponse in form` — because the user the test signs in as does not exist
> in the realm actually loaded. Run
> `docker compose -f docker-compose.test.yml up -d --force-recreate keycloak`.

CI runs lint in its own job, `pnpm test` and `pnpm build` in another, and Playwright in a third
that starts *alongside* those rather than after them — it is the longest job in the workflow, so
gating it on the suite added its minutes to the wait instead of overlapping them. The packaging
smoke test that installs the CLI tarball outside the workspace, and the CLI and SSO end-to-end
suites, do still wait for `pnpm test`.

On a pull request each of those jobs runs only if the diff can reach it: a `changes` job
classifies every changed path and the rest gate on its output. A CLI-only change skips the browser
suite, a web-only change skips the packaging one, and a diff of nothing but prose and `.github/`
skips all five — but a `.md` under `examples/*/seed/` is a fixture the suites index, so it counts
as code. An unrecognised path runs everything, which is the direction the mistake has to fall in.
A push to `main` is never filtered.

That `.github/` exemption cuts both ways: editing a job's own steps does not exercise them on the
pull request that edits them. `changes` still runs every time and still fails loudly if the
classifier itself breaks, but a change to what `test` or `e2e` actually does is proved by the
unfiltered run on `main` after the merge.

### Running two checkouts at once

`pnpm e2e` is safe to run in two checkouts simultaneously. Nothing needs to be
configured for it, but it is worth knowing what makes it safe, because the
failure it prevents does not look like a collision — it looks like your code is
broken.

Sibling workspaces share `127.0.0.1:54330`, whichever one ran `pnpm test:up`
first. Sharing the Postgres *server* is fine and intended. Sharing a *database*
or an *app port* is not:

- A shared database is destructive — each `e2e:setup` drops and recreates it, so
  one suite pulls the schema out from under the other mid-run. It surfaced as
  `relation "session" does not exist`, `column g.org_id does not exist`, and
  hangs well past Playwright's own timeout.
- A shared port is worse, because it is *silent*. Playwright's usual
  `reuseExistingServer: !process.env.CI` cannot tell whose dev server answers on
  a port, so it adopts the other checkout's — and the suite then exercises that
  checkout's code against that checkout's database while reporting the result as
  yours. Its signature is a plausible-looking failure run: 404s on routes that
  demonstrably exist, and assertions failing against seed data from a branch that
  is not checked out here.

So neither is shared. Both are derived from the repository root's directory name,
and adoption of a foreign server is refused outright:

- **Databases** — `scripts/e2e-setup.ts` and `apps/web/playwright.config.ts`
  independently derive `warehousd_e2e_<workspace-dir>`. Override with
  `WAREHOUSD_E2E_DB`.
- **App port** — `playwright.config.ts` hashes the same slug into 8800-8899,
  clear of 8722 (`pnpm dev`), 8723 (`warehousd start`'s database) and 8780
  (Keycloak). Override with `WAREHOUSD_E2E_PORT`. Your
  own `pnpm dev` on 8722 is untouched by, and cannot interfere with, a suite run.
- **Adoption** — `reuseExistingServer` is `false` unconditionally. There is
  nothing legitimate to reuse once the port is per-workspace, and the failure it
  buys back is a loud one.

Two guards keep a residual collision from going quiet. Playwright refuses to
start when something already answers on the origin, and
`scripts/assert-port-free.mjs` runs ahead of `next dev` because `next dev -p N`
does *not* fail on a busy port — it binds N+1 and carries on.

Vitest names its databases `wh_<label>_<pid>_<suffix>` through `runDbName` in
`packages/broker/test/helpers/templates.ts`, called from
`packages/broker/test/helpers/db.ts` and `apps/web/test/helpers/web-db.ts`. The
suffix is the same per-checkout hash the template databases carry, and the pid
alone was not enough: pids repeat across checkouts, so a leftover clone could not
be told from a sibling's live one. With it, `scripts/agent/cleanup.sh` can drop
this checkout's abandoned databases while another checkout's suite is still
running. The ~90 test files mentioning `http://localhost:8722` only build
`Request` objects for route handlers; none binds a port.

The servers the suites *do* bind — the fake IdP in `helpers/fake-idp.ts` and the
one-off ones in `sso-admin`, `admin-sso-ui` and `token-exchange` — all listen on
port 0 and hand their real origin back to the caller. The fake IdP used to be
fixed on 8791, which collided both across checkouts and, once test files began
running in parallel, between `sso-oidc` and `sso-local-login-disabled` in a
single run. `startFakeIdp` appends its ephemeral origin to
`WAREHOUSD_TRUSTED_ORIGINS`, which is why it has to be started before
`setupWebDb` imports `lib/auth`.

Keycloak (8780) is fixed and shared, but it is reached only by `test:e2e:sso`,
which is gated behind `WAREHOUSD_E2E_KEYCLOAK` and is not part of `pnpm test` or
`pnpm e2e`.

`ps aux | grep -E "vitest|next-server"` catches orphaned workers, which outlive
a `pkill` aimed at their parent shell and will otherwise hold the port.

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
  denies everything, multi-value vocabularies use array-overlap (`&&`) semantics,
  and a second approved grant is refused by the unique index.
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
- **Proposals** (`proposals`) — a `proposal_only` grant yields `status: "pending"`
  and leaves the document unchanged in both `query` and `getDocument`; the pending
  after-state is not readable through the view by anyone; approve merges and
  promotes; reject leaves the row in place with `_rev_status='rejected'`; revoking
  the approver's grant makes the very next approval refuse.
- **Merge and conflict** (`proposal-merge`) — two proposals on disjoint fields both
  promote and the final document carries both changes; two on overlapping fields
  make the second refuse `conflict`; a stale `_rev_base` with overlap refuses while
  a stale base without overlap promotes; the merged revision credits the proposer,
  not the approver; `_rev_seq` is strictly increasing per document throughout.
- **Approval authorization** (`proposal-authz`) — approving a proposal touching a
  field outside the approver's grant refuses `field_denied` (the
  approve-requires-read invariant); an approver whose document filter excludes the
  document gets `not_found`; a grant without `approve` gets `verb_denied`;
  `listProposals` returns no field values, asserted by stringifying and grepping
  for the proposed value.
- **Change feed** (`change-feed`) — a create, update, delete, file create, proposal
  and approval each write exactly one entry; the feed carries no field values and
  no field names, asserted by stringifying and grepping; `since` is exclusive and
  strictly ordered; a caller sees only their own org's and env's entries, and none
  from a collection they hold no grant on. Two proofs worth naming: revoking the
  write role's `insert` on `app.change_log` makes the whole mutation disappear,
  showing the revision and the feed row share one transaction; and two interleaved
  writers yield every committed revision exactly once across successive polls,
  showing the cursor is not lossy when `seq` order diverges from commit order.
- **Client secrets** (`client-secrets`) — the plaintext is unrecoverable after
  creation and appears in no query result; a revoked key fails the next verify with
  no expiry wait; an expired key is refused; both secrets verify during a rotation
  window and the retired one stops only on explicit revoke; a third unrevoked
  secret is refused; creation beyond the lifetime ceiling is refused; a malformed
  checksum is rejected with no database round trip.
- **Collection ceiling** (`collection-ceiling`) — a user holding a grant on a
  collection outside the client's ceiling is refused through that client and
  allowed through another; the refusal is `no_grant`, indistinguishable from having
  none; a ceiling can never widen access; a null ceiling behaves as before.
- **Env-scope parity** (`env-scope-parity`) — table-driven over every combination of
  requested scopes, policy and live eligibility, so the OAuth path and the key path
  cannot answer differently. Covers the `env:dev` floor and the separate
  refresh-time recompute that lets a promotion reach an existing token.
- **Audit `via`** (`audit-via`) — allowed and refused outcomes both record which
  credential produced them.
- **Audit completeness** (`audit`) — every outcome above writes an event, and the
  audit role cannot UPDATE or DELETE.
- **Intent validation** (`sql-build`, `apps/web/test/mcp-tools.test.ts`,
  `rest-api.integration`) — no value in a client-supplied intent reaches SQL as
  syntax. Covers the injected `aggregate.fn`, prototype-chain operator names, and
  non-numeric `limit`, over both the REST and MCP paths.
- **Four eyes** (`proposal-authz`, `rest-api.integration`) — a proposer cannot
  approve or reject their own proposal, whatever verbs their grant carries.

## What is still manual

The Playwright suite covers every web surface. Four things are still
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
4. **Deploying to Fly.io.** [deploy-fly.md](deploy-fly.md) — end-to-end
   provisioning: configuring the `deploy:` block, ensuring demo is off and SSO
   is configured, running the deploy, verifying the stack reaches health checks,
   and connecting Claude to the deployed server.

Re-run all four whenever the OAuth flow, the login page, the env-scope rules,
or the deploy machinery change materially — they are the only checks that
exercise the full chain the way a user experiences it.
