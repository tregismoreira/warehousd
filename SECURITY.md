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

- **The `wh_env` cookie is not marked `Secure`** (`apps/web/app/api/env/route.ts`)
  because the local demo runs on plain HTTP. It is `HttpOnly; SameSite=Lax` and
  is not a privilege path — setting it to `live` without an approved live grant
  still refuses with `no_grant` — but it should be conditional on HTTPS before a
  real deployment.
- **The two-tier deny is enforced at the API layer, not in the broker library.**
  `/api/grants` validates requested fields against `grantableFields()`, so a
  `posture: deny` field can never be requested or approved through the web UI or
  HTTP API. `approveGrant`/`requestGrant` in `packages/broker` do not repeat that
  check, so a future adapter calling them directly could create a grant the YAML
  forbids. Defense in depth we have not yet added.
- **Config merging is not prototype-safe.** `deepMerge` in
  `packages/broker/src/config/load.ts` assigns keys from `warehousd.local.yml`
  as computed properties, including `__proto__`. Reachable only by whoever can
  write that file, which is already the person who decides the postures.
- **No multi-tenancy.** One deployment is one organization. There is no boundary
  between tenants because there are no tenants.
- **No write path through MCP.** Read and access-request only, by design. The
  admin CSV/JSON import is append-only through an `INSERT`-only Postgres role.
