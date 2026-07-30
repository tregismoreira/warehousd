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
- **Turn demo mode off** (`demo: false` / no `WAREHOUSD_DEMO`). Demo mode seeds
  three accounts with the password `demo` and shows them on the login page.
- **Never point a file collection's `source` at real corporate files.** `source`
  is dev content by definition; live content is indexed only through an explicit
  `--env live` action.
- **Keep `warehousd.yml` and `warehousd.local.yml` operator-controlled.** Config
  is trusted input — it is the file that decides what can ever be granted.

## Known limitations

Deliberate gaps in the current implementation. None is a live exploit path in a
deployment that follows the expectations above, but each is worth knowing:

- **`approveGrant` does not re-check the two-tier deny.** The request side is
  enforced in the broker: `validateGrantRequest`
  (`packages/broker/src/grants/manage.ts`) rejects any field outside
  `grantableFields()`, and both callers that reach `app.grants` — the web route
  and the MCP `request_access` tool — go through it. `approveGrant` still trusts
  the `allowedFields` it is handed. The web approve path is safe because
  `buildApproval` derives the field set from the YAML rather than the request
  body, but that is a caller-side guarantee rather than one the broker enforces,
  so a future adapter calling `approveGrant` directly could widen a grant beyond
  what the config allows.
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
- **An API key's `whd_dev_` / `whd_live_` prefix is a label, not a ceiling.** It
  exists so a leaked key can be triaged on sight, and `verifyClientSecret` reports
  it — but nothing narrows access to it. What bounds the environment is
  `client_policies.allowed_scopes` intersected with the user's live-grant
  eligibility. Both admin routes currently mint with `dev`, so a live-prefixed key
  cannot be created; enforcing the prefix would cap every delegated client at dev
  with no way to opt out. Making it a real ceiling needs a way to mint a live key
  first.
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
  and refuses, on *both* paths, any filter it cannot compare with certainty: a
  `json` field, a `view_join` field, a timestamp with no timezone, and any value
  that is not a valid instance of its column's declared type. This narrows what a
  grant author may write, and it is the deliberate trade: a filter that silently
  means something different to the reader and the writer is worse than one that is
  rejected outright. Filter values are still validated only when a grant is
  *used*, not when it is approved, so a malformed filter surfaces as
  `invalid_intent` on the next call rather than as an error at approval time.
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
- **Write tools are exposed over MCP.** `create_document`, `update_document` and
  `delete_document` are MCP tools, so the untrusted model can propose writes. It
  cannot decide on them: `approve`/`reject` are not MCP tools, and the broker
  refuses `self_approval_denied` when the approver is the proposal's author, so a
  single credential cannot both propose and promote. The admin CSV/JSON import is
  separate and append-only through an `INSERT`-only Postgres role.
