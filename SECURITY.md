# Security policy

warehousd exists to keep data away from callers who should not see it. A bug in
that path is the most serious kind of bug this project can have, and we would
rather hear about it early and privately.

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion for a security bug.**

Use GitHub's private reporting: the **Security** tab → **Report a
vulnerability**. Include what you probed, the response you got, and — if a
denied value leaked — where it surfaced (response body, error message, log line).

We aim to acknowledge within 3 working days and to ship a fix or a mitigation
plan before any public disclosure. warehousd is pre-1.0: fixes land on `main`
and in the next tagged release; there are no long-term support branches.

## What counts as a vulnerability

Anything that breaks one of the invariants in
[docs/architecture.md](docs/architecture.md). In practice:

- A caller reading a field their grant does not cover, or a collection they have
  no grant for.
- A denied value appearing anywhere — response, error, log, timing, row count,
  aggregate.
- A `dev`-scoped token reaching `data_live`, or vice versa.
- A client obtaining `env:live` without both a policy allowing it and an
  eligible user.
- A grant surviving revocation or expiry, or a broker decision that writes no
  audit event.
- Client-supplied input reaching SQL other than as a bound parameter.

## Deployment expectations

warehousd assumes the operator does these; failures caused by not doing them are
not vulnerabilities in warehousd:

- **Serve over TLS.** Sessions, OAuth codes, and tokens all cross the wire.
  `warehousd deploy` enforces this by serving over HTTPS automatically on the
  platform targets, Fly.io and Railway, which terminate TLS on the domains they
  issue. Other deployments remain the operator's responsibility — the `compose`
  target publishes on loopback for a reverse proxy to terminate TLS in front of,
  and says so in its summary; it cannot do the terminating.
- **Turn demo mode off** (`demo: false` / no `WAREHOUSD_DEMO`). Demo mode seeds
  three accounts with the password `demo` and shows them on the login page.
  `warehousd deploy` refuses the deployment if demo mode is on, whichever
  target it is deploying to, so the expectation is mechanically enforced for
  every deployment it makes. Containers you start yourself remain the
  operator's responsibility.
- **Never point a file collection's `source` at real corporate files.** `source`
  is dev content by definition. `source_live` is not: the container bootstrap
  indexes it into `data_live` on every start where the directory is present, so
  treat naming it as granting the deployment read access to that content.
  `warehousd deploy` never puts those directories in the bundle it ships — as
  an image layer on Fly.io and Railway, as a read-only bind mount under
  `compose` — so no
  deployment it makes can index them; a container you mount the project
  directory into yourself can, and
  `warehousd index <collection> --env live` remains the explicit one-off path.
- **Keep `warehousd.yml` and `warehousd.local.yml` operator-controlled.** Config
  is trusted input — it is the file that decides what can ever be granted.

## Known limitations

Deliberate gaps in the current implementation. None is a live exploit path in a
deployment that follows the expectations above, but each is worth knowing:

- **A connect-in-place collection has one isolation wall, not two.** Every other
  collection is confined to its org by the view's `org_id` predicate *and* by an
  RLS policy on the base table. A `postgres_fdw` foreign table can carry neither:
  it has no `org_id` column, and RLS does not apply to it. The view instead
  compares the request's org against the constant `org:` declared on the source,
  which is enforcement in the database rather than in broker code — but it is one
  mechanism where the rest of the system has two.
- **An external source is trusted to the extent of its user mapping.** warehousd
  reads it with the credential you supply, so that credential should be a
  read-only role scoped to the tables you declared. warehousd cannot narrow it
  further: `updatable 'false'` stops warehousd writing, it does not stop the
  credential from being over-privileged.
- **`embedding.provider: openai` / `http` sends document text to a third party.**
  That is the point of the setting and it is opt-in — `local` is the default and
  keeps content on the machine — but a deployment that turns it on has moved
  governed content outside the boundary the rest of this document describes.
- **No multi-tenancy.** One deployment is one organization. There is no boundary
  between tenants because there are no tenants.
- **A token carrying no `env:` scope is read as `env:dev`.** The env rules leave a
  caller that requested no env scope untouched, and the adapter supplies the
  floor. Both token-issuing paths now resolve a concrete env and record it, so
  this is a backstop rather than a normal outcome — but a token minted by some
  other path with no env scope reads `data_synth`, and a client policy that allows
  no environment does not stop it. The default is deliberately in the safe
  direction: `env:dev` is generated data, and `env:live` is never implied — real
  data requires the scope to be explicitly present, which requires both a policy
  allowing it and a user with an approved, unexpired live grant.
- **A trusted issuer's `subject_claim` is trusted as an identity.** In the
  delegated (RFC 8693) flow the claim named by `subject_claim` is matched against
  a local user's email address. warehousd requires that the value be a
  well-formed address and that the subject token assert `email_verified: true`,
  and it pins the accepted signing algorithms and requires an `exp`. It cannot
  tell whether the claim an operator chose is one the IdP guarantees. Pointing
  `subject_claim` at a user-editable claim — `preferred_username` on some
  directories — makes account takeover an IdP profile edit. Use `email`, or a
  claim your IdP documents as immutable.
- **A document filter's value must be exactly comparable, or the grant is
  refused.** A filter is evaluated in SQL on the read path and in process on the
  write path (the write path reads base tables for revision bookkeeping and cannot
  reuse the read path's SQL). Rather than approximate Postgres's input parsing in
  JavaScript — which cannot be done faithfully — warehousd canonicalises both sides
  and refuses, on _both_ paths, any filter it cannot compare with certainty: a
  `json` field, a `view_join` field, a timestamp with no timezone, and any value
  that is not a valid instance of its column's declared type. This narrows what a
  grant author may write, and it is the deliberate trade: a filter that silently
  means something different to the reader and the writer is worse than one that is
  rejected outright. The check runs at approval time as well as at use time, so an
  unevaluable predicate is refused (`invalid_filter`) while an approver is still
  present to be told which one — with one exception on each side. `$self` has no
  value to canonicalise until the grant is loaded, so it is checked only at use
  time; and because the config can change after a decision, an already-approved
  grant can still carry a filter that has since become unevaluable, which surfaces
  as `invalid_intent` on the next call.
- **The change feed discloses document ids past a grant's document filter.**
  `broker.changes` is filtered to collections the caller holds a `read` grant on,
  but a grant's _document_ filter is not applied to it — the feed carries no field
  data, so there is nothing to evaluate a predicate against. A caller therefore
  learns that some document in a collection they can read changed, its id, the op,
  and when; not which fields moved or what they hold. `getDocument` still refuses
  the ones outside the filter. The bounded leak is a document-id enumeration and a
  change-rate signal, which is the price of the feed existing at all: the
  alternative — joining the base tables to test the filter — would put field data on
  the control plane, which is the larger hole. Where document ids are themselves
  sensitive, do not issue a document-filtered grant expecting the feed to honour it.
  A per-document ACL is not applied to the feed either, and for the same reason:
  the feed carries no field data and no ACL join, so a restricted document's id,
  op and timestamp appear to anyone with a `read` grant on the collection.
  `getDocument` still refuses it. See
  [The change feed](docs/architecture.md#the-change-feed).
- **OAuth client secrets are stored in cleartext, and the library currently
  requires it.** `app."oauthApplication"."clientSecret"` holds the secret verbatim
  for the dev client and for every dynamically registered MCP client, so a database
  dump of that table is a set of working client credentials. Treat it as
  credential-bearing.

  Better Auth's `oidcProvider` has a `storeClientSecret: "hashed"` option, and
  setting it does not work here. In better-auth 1.4.21 the mcp plugin's own token
  endpoint authenticates by comparing the column to the presented value directly
  (`client.clientSecret === client_secret`, `dist/plugins/mcp/index.mjs`) rather
  than through the provider's configurable verifier, so a hashed column makes every
  `/api/auth/mcp/token` exchange fail with `invalid client_secret`. The same
  plugin's dynamic-registration handler writes the generated secret straight to the
  column without calling the provider's hasher, so the option would not have
  protected DCR secrets — the case worth protecting — even where it did apply.

  Turning it on was tried and reverted; the CLI lifecycle e2e (Step 6) is what
  catches it, because the failure lives in the library's endpoint rather than in
  any code here. What limits the exposure meanwhile: these secrets grant no data
  access on their own — a token still needs a user session, a client policy
  allowing the env, and an approved grant — and `client_policies.allowed_collections`
  caps what any client can reach. Revisit when the mcp plugin routes client
  authentication through the provider.

- **A per-document ACL depends on group membership warehousd stores, not on what
  the IdP asserts at request time.** `group:` principals resolve against
  `app.user_groups`, which is written by an SSO login (`source: 'sso'`) and by the
  console (`source: 'manual'`). That is the point — a deny that depended on a claim
  minted outside the broker would not be a deny — but it means membership is as
  fresh as the last login, not as fresh as the directory. An IdP removing someone
  from a group does not revoke their `group:` principals until they sign in again.
  Where that window matters, remove the principal from the ACL or the row from
  `app.user_groups` directly. An assertion that carries *no* group claim at all
  deliberately changes nothing, so a provider registration that forgets to map the
  claim cannot silently revoke everyone's membership.
- **An ACL restricts, it never grants.** A principal listed on a document still
  needs a grant covering the collection and the fields. Adding somebody to an ACL
  gives them nothing they did not already have; removing everybody makes the
  document public *within the grant*, not public.
- **ACL rows are the one thing a write role may DELETE.** Every other data table is
  append-only by privilege. An ACL has no revision model and nothing references it,
  so removing the row is the only way to un-restrict a document — which also means
  an ACL's history is not recoverable from the data schema. The audit trail records
  each change (`set_acl`, with the principals) and is where that history lives.
- **Write tools are exposed over MCP.** `create_document`, `update_document` and
  `delete_document` are MCP tools, so the untrusted model can propose writes. It
  cannot decide on them: `approve`/`reject` are not MCP tools, and the broker
  refuses `self_approval_denied` when the approver is the proposal's author, so a
  single credential cannot both propose and promote. The admin CSV/JSON import is
  separate and append-only through an `INSERT`-only Postgres role.

## Out of scope

Absence here is a decision, not an oversight. These are things warehousd does not
attempt, so that a report of "X is missing" can be answered quickly and a report
of something genuinely broken is not buried among them.

- **Multi-tenancy beyond the org column.** Every grant, audit event and document
  carries an org, isolated by a view predicate and RLS, but one deployment is
  intended to serve one organization. It is not a hostile-tenant boundary.
- **A malicious administrator, or anyone with Postgres superuser.** An admin can
  grant themselves access and the audit trail will record it; that is the
  control. Superuser is outside the model entirely — it can rewrite the trail.
- **Abuse detection beyond rate limiting and lockout.** Per-IP throttling
  (Better Auth), per-client throttling on `/v1/token` and per-account lockout on
  local credentials. No behavioural analysis, no anomaly detection.
- **Distributed rate limiting.** The `/v1/token` limiter is in-memory and
  per-process *by design* — it is a CPU cost cap, not a quota. Behind several
  machines each holds its own window. A real quota belongs at the ingress.
- **SCIM and compliance exports.** Users arrive by SSO or by an admin creating
  them; there is no directory sync and no packaged evidence export. IdP
  group→role mapping *is* built, and an SSO login also persists the asserted
  group list — but that is a pull at login, not a directory sync: nothing is
  pushed, nothing is reconciled, and a user who never signs in again keeps the
  membership their last login asserted. See the component status table, and the
  known limitation above on how fresh a `group:` principal is.

## Dependency advisories

CI runs `pnpm audit --prod --audit-level high` (the `quality` job in
`.github/workflows/ci.yml`). It is a blocking gate: a new high or critical advisory
in the production dependency tree fails the build.

A short list of advisories is suppressed in `package.json` under
`pnpm.auditConfig.ignoreGhsas`, because pnpm's config file is JSON and cannot carry
the reasons. Each is here because it cannot be fixed from this repository, not
because it was judged unimportant. Re-check them whenever `next` or `vitest` moves.

| Advisory | Package | Why it is suppressed |
|---|---|---|
| [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp) | `vitest` | Reachable only through `better-auth`'s *optional peer* declaration, which our own dev-time vitest satisfies — it is not a runtime dependency of anything this app serves. The vulnerability requires the Vitest UI server to be listening; nothing here starts it. Clearing it needs a vitest 3 major upgrade of the whole suite. |
| [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) | `vite` | Transitive under the same vitest peer, and Windows-only (`server.fs.deny` bypass on alternate paths). Same upgrade clears it. |
| [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) | `sharp` | Pinned by `next`. Needs either a Next upgrade or a `pnpm.overrides` entry, and an override on an image codec wants a full build and e2e run behind it. |
| [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q), [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) | `postcss` | Both are source-map disclosure through an attacker-controlled `sourceMappingURL` in CSS. Pinned by `next`; this project authors no CSS from untrusted input, and source maps are not served in production. |

Adding to this list is a deliberate act: state the reason in this table in the same
change, or fix the advisory instead.

One advisory is handled by an override rather than a suppression.
[GHSA-gpj5-g38j-94v9](https://github.com/advisories/GHSA-gpj5-g38j-94v9)
(`drizzle-orm <0.45.2`, SQL injection through improperly escaped identifiers) reached
the production tree twice over. The first path was a direct dependency of
`packages/broker` supporting a typed schema mirror that nothing imported; the file and
both `drizzle` dependencies are gone, and `db/migrations/` is now the only definition
of the `app` schema. The second path survives that removal:
`@better-auth/cli` is still on 1.4.21 — there is no 1.6.x — and that older
`better-auth` declares the optional peer as `>=0.41.0`, so pnpm resolved 0.41.0 and
deduplicated it into the production `better-auth@1.6.25`, which asks for `^0.45.2`.
The `pnpm.overrides` entry pinning `drizzle-orm` to `^0.45.2` patches the advisory and
settles that peer conflict in favour of the version production actually wants. Nothing
loads it either way: `apps/web/lib/auth.ts` passes `database: appPool`, so better-auth
uses its `pg`/kysely adapter and the drizzle adapter is never constructed. Drop the
override once `@better-auth/cli` ships a 1.6-compatible release.
