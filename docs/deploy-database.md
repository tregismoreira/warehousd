# Deploying against a hosted Postgres

`deploy.database` takes exactly one of two shapes. `managed: true` lets the
deploy target provision the database; `url:` attaches one you already run. This
page is about the second — pointing warehousd at Supabase, Neon, Railway or any
other hosted Postgres.

```yaml
deploy:
  target: fly
  app_name: harbor-warehousd
  region: gru
  database:
    url: ${env:PROD_DATABASE_URL}
    provider: supabase        # optional; see "The provider key" below
```

## What warehousd needs from a database

Not much, but the list is not negotiable — every item is load-bearing for an
invariant rather than a convenience:

| Need | Why |
| --- | --- |
| `CREATEROLE` or superuser on the connecting role, directly or inherited | Boot creates `warehousd_dev`, `warehousd_live`, `warehousd_dev_write` and `warehousd_live_write` and rotates their passwords. Those four roles **are** the dev/live wall: the database refuses a cross-environment read, not the broker. Membership counts — see below. |
| `vector` and `pgcrypto` | `pgcrypto` for `hmac()`, behind `mask: { transform: hash }`; `vector` for semantic search and the file-collection embedding column. |
| `postgres_fdw`, only if you declare `sources:` | Neither Supabase nor Neon allows it. A project with no external source is never asked for it. |
| A reachable schema for any of the above installed outside `public` | Covered below. |
| Connection startup parameters | `search_path`, `statement_timeout` and `idle_in_transaction_session_timeout` are set on connect. A transaction pooler in front of Postgres drops them. |

`warehousd deploy` checks all of this before it builds an image, as `db-*`
lines in the pre-flight output:

```
✓ db-reachable        connected to db.abcdefghij.supabase.co:5432
✓ db-can-create-role  postgres may create roles
✓ db-extensions       vector, pgcrypto available on this server
✓ db-search-path      pgcrypto in "extensions" — reachable, or grantable by this role
✓ db-provider         Supabase on port 5432 — session pooler or direct
```

These run only when `database.url` is set. Under `managed: true` there is no
database yet to ask. `warehousd doctor --deploy` runs the same lines without
deploying anything.

### CREATEROLE through membership

`db-can-create-role` asks whether the connecting role has `CREATEROLE` or
`SUPERUSER` **directly or through any role it inherits from**, not whether the
attribute is set on the role itself. That distinction is the whole check on a
hosted provider: Neon's `neondb_owner` has neither attribute and gets
`CREATEROLE` through membership in `neon_superuser`, and RDS has the same shape
with `rds_superuser`. Reading the role's own attributes refused every correctly
configured Neon project.

One caveat, stated rather than hidden: stock Postgres does not confer
`CREATEROLE` through membership — role attributes are not inherited — so on a
vanilla server this check can pass for a role that would still fail at boot. It
errs toward not blocking on purpose. The providers this matters for patch
exactly this behaviour, and the release command still catches the genuine
failure; refusing every Neon deployment up front does not.

### db-search-path on a first deploy

`db-search-path` decides on capability, not on the roles that happen to exist.
On a database that has never booted there are no `warehousd_*` roles yet, so
"which of them lack usage on the extension schema" is a question with no rows —
and the check used to read that as a pass. It now refuses unless the connecting
role owns the schema, or `PUBLIC` already holds usage on it (which a role
created later inherits).

That is the run where the answer matters. After the first boot,
`ensureExtensionSearchPath` has already done the work.

## Extensions outside `public`

On a local Postgres `create extension` puts everything in `public`, which every
role already reaches. A hosted Postgres often does not: Supabase ships
`pgcrypto` preinstalled in a schema called `extensions`, which makes
`create extension if not exists pgcrypto` a silent no-op.

The failure mode is the bad one — `apply` succeeds, boot succeeds, and the
first masked read fails at request time with `internal_error`. warehousd
handles this at apply time: it reads back where the extensions actually landed,
grants the warehousd roles usage on those schemas, and puts them on each role's
`search_path` for that database only.

That needs the connecting role to either already have the grant or be able to
make it — which is what `db-search-path` checks for. If it refuses, connect as
the role that owns the schema, or grant usage by hand and deploy again.

## The provider key

`provider` names who runs the database. It is only ever an override: the
hostname normally says so, and `generic` — plain role names, no
provider-specific checks — is the fallback for anything unrecognised, which is
exactly how every URL behaved before this key existed.

Set it when the host does not advertise the provider: a CNAME onto your own
domain, or a proxy in front. Setting it without a `url` is refused, because it
would name where a database that is not there is hosted.

Getting it wrong is not a parse error; it is a role that cannot authenticate.
So `db-provider` refuses a value the host contradicts — `provider: supabase` on
a `*.neon.tech` url — naming both:

```
✗ db-provider  warehousd.yml says provider: supabase (Supabase), but
               ep-cool-1.eu-central-1.aws.neon.tech:5432 is a Neon host. Role names are
               derived per provider, so the wrong one produces a role that cannot
               authenticate. Set provider: neon, or drop the key and let the host decide.
```

A value set over a host nothing recognises stays valid, and is left alone —
that is the CNAME case the key exists for, and the only one where you know more
than the hostname does.

`warehousd init --db-provider <id>` writes the key, alongside the `--target` that
gives it a block to sit in. It is worth setting there even when the host would
be recognised: at scaffold time the url is still a `${env:…}` reference, so there
is no host to read it off yet.

| Value | Host patterns | What differs |
| --- | --- | --- |
| `supabase` | `*.supabase.co`, `*.pooler.supabase.com` | Role names carry the project ref through the pooler; the transaction pooler is refused |
| `neon` | `*.neon.tech` | Advises `sslmode=require` |
| `railway` | `*.railway.app`, `*.rlwy.net`, `*.railway.internal` | Nothing — plain container, superuser owner |
| `generic` | everything else | Nothing |

## Supabase

**Use the session pooler or the direct connection. Not the transaction
pooler.** In the Supabase dashboard, Connect → the string on port `5432`, not
the one on `6543`.

`warehousd deploy` refuses `:6543` outright. The reason is that warehousd sets
three connection startup parameters — `search_path` for the auth schema, and
`statement_timeout` / `idle_in_transaction_session_timeout` as the ceilings on
a pathological query — and the transaction pooler does not honour them. Those
timeouts are deliberately pool-level rather than per-request `set` statements:
a ceiling you can forget to apply is not a ceiling. The transaction-scoped
`set_config` the broker uses for org isolation *would* have been pooler-safe,
so this is a single blocker rather than a fundamental one, and it may be
revisited.

The other Supabase-specific thing is the username. Through Supavisor one pooler
fronts every project in a region, and the username is how it knows which:
`postgres.<project_ref>`. So "the same database, as `warehousd_dev`" is spelled
`warehousd_dev.<project_ref>`, not `warehousd_dev` — and a bare role name
authenticates as nobody. warehousd derives this for you from the URL you give
it; the `supabase` provider is what makes it happen.

Connect as the project's `postgres` role. It has `CREATEROLE`, and it owns the
`extensions` schema, which is what lets the apply grant usage on it.

## Neon

Add `?sslmode=require` to the URL. Neon's proxy negotiates TLS regardless, so
this is about your client refusing a downgrade rather than about today's
connection being in the clear; the pre-flight says so rather than refusing.

Connect as `neondb_owner` (or whichever role owns the database). It has no
`CREATEROLE` attribute of its own — it is a member of `neon_superuser`, which
is where the privilege comes from, and `db-can-create-role` asks the inherited
question for exactly this reason. Roles created through SQL are not members of
`neon_superuser`, which is fine: the four warehousd roles never need to own
anything, only the grants boot hands them.

A Neon endpoint that has scaled to zero takes a few seconds to wake. Boot waits
up to 60s for Postgres to answer, so a suspended endpoint is a slow first
request, not a failed deploy.

## Railway

A Railway Postgres is a plain container whose `POSTGRES_USER` is a real
superuser, with no pooler in front of it. Nothing about it differs from a local
Postgres: plain role names, `create role` and `create extension` both work, and
there are no provider-specific pre-flight checks.

Use `DATABASE_PUBLIC_URL` (the `*.rlwy.net` proxy) when warehousd runs
elsewhere; `DATABASE_URL` (`*.railway.internal`) only resolves from inside
Railway's private network, which also means the pre-flight cannot reach it from
your machine.

## Anything else

`generic` is the fallback and it is not a downgrade — it is what every
deployment did before providers existed. The role URLs are derived by swapping
the username, and the four capability checks above still run. If your provider
needs something different, that is one file in
`packages/broker/src/db/providers/`.

## Verifying the wall

The point of getting role derivation right is that the database, not the
broker, refuses a cross-environment read. Confirm it after the first deploy —
a subtly wrong derivation shows up here as an **allow** and nowhere else:

```bash
# as warehousd_dev, against live data — must be `permission denied`
psql "$DEV_ROLE_URL" -c 'select * from data_live.people limit 1'

# as warehousd_live, against synthetic data — same
psql "$LIVE_ROLE_URL" -c 'select * from data_synth.people limit 1'
```

Then exercise a masked read and a `search_documents` call, which are what prove
`hmac()` and the `vector`/`<=>` operators resolve for those roles on a provider
that installed the extensions outside `public`.
