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
- **A trusted issuer's `subject_claim` is trusted as an identity.** In the
  delegated (RFC 8693) flow the claim named by `subject_claim` is matched against
  a local user's email address. warehousd requires that the value be a
  well-formed address and that the subject token assert `email_verified: true`,
  and it pins the accepted signing algorithms and requires an `exp`. It cannot
  tell whether the claim an operator chose is one the IdP guarantees. Pointing
  `subject_claim` at a user-editable claim — `preferred_username` on some
  directories — makes account takeover an IdP profile edit. Use `email`, or a
  claim your IdP documents as immutable.
- **Write tools are exposed over MCP.** `create_document`, `update_document` and
  `delete_document` are MCP tools, so the untrusted model can propose writes. It
  cannot decide on them: `approve`/`reject` are not MCP tools, and the broker
  refuses `self_approval_denied` when the approver is the proposal's author, so a
  single credential cannot both propose and promote. The admin CSV/JSON import is
  separate and append-only through an `INSERT`-only Postgres role.
