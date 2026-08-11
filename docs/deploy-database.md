# Deploying against a hosted Postgres

`deploy.database` takes one of three shapes.

| Shape | Who creates the database |
| --- | --- |
| `managed: true` | The deploy target — `fly postgres create`, `railway add --database postgres`. |
| `managed: true` + `provider:` | warehousd, through that provider's own CLI. |
| `url:` | Nobody. You already have one. |

The second is the one to reach for when the database should not live on the platform running the container — Supabase or Neon behind a Fly app, say. Here warehousd creates the project, records what it made, connects to it, and deletes it again on `--destroy`:

```yaml
deploy:
  target: fly
  app_name: harbor-warehousd
  region: gru
  database:
    managed: true
    provider: neon             # supabase | neon
    region: aws-sa-east-1      # the database's region, not the target's
```

`warehousd init --db-provider neon --db-region aws-sa-east-1` scaffolds exactly that, checks the Neon CLI is installed, and offers to install it if not.

The third shape is the manual path, and it stays first-class — nothing below stops applying to it:

```yaml
deploy:
  target: fly
  app_name: harbor-warehousd
  region: gru
  database:
    url: ${env:PROD_DATABASE_URL}
    provider: supabase        # optional; see "The provider key" below
```

## Letting warehousd create it

One command, and the rest is the same deploy it always was:

```bash
warehousd init --no-input --target fly --db-provider neon --db-region aws-sa-east-1
warehousd doctor --deploy    # is the Neon CLI there, and authenticated?
warehousd deploy
```

Three things are worth knowing before the first run.

**It costs money.** A Supabase or Neon project on a paid plan is billed from the moment it exists, and on a free plan it counts against the project limit. The deploy summary names what warehousd created.

**The record lives in `.warehousd/state.json`.** That file — mode `0600`, already gitignored — is how a second `warehousd deploy` knows to reconnect rather than create a second project. Fly and Railway get this for free, because the target's own project is the identity; a provider host has none, so losing the state file means the next deploy creates another database. For Supabase it also holds the **only** copy of the database password: `supabase projects create --db-password` is the one place that value can be set, and nothing reads it back.

**Authentication is yours.** `supabase login` and `neon auth` open a browser, and warehousd never runs them for you. The pre-flight reports "not authenticated" with the command that fixes it.

Tearing down deletes the database. `warehousd deploy --destroy` names the project in the confirmation prompt and removes it after the app, in that order.

## What warehousd needs from a database

Not much, but the list is not negotiable — every item is load-bearing for an invariant rather than a convenience:

| Need | Why |
| --- | --- |
| `CREATEROLE` or superuser on the connecting role, directly or inherited | Boot creates `warehousd_dev`, `warehousd_live`, `warehousd_dev_write` and `warehousd_live_write` and rotates their passwords. Those four roles **are** the dev/live wall: the database refuses a cross-environment read, not the broker. Membership counts — see below. |
| `vector` and `pgcrypto` | `pgcrypto` for `hmac()`, behind `mask: { transform: hash }`; `vector` for semantic search and the file-collection embedding column. |
| `postgres_fdw`, only if you declare `sources:` | Neither Supabase nor Neon allows it. A project with no external source is never asked for it. |
| A reachable schema for any of the above installed outside `public` | Covered below. |
| Connection startup parameters | `search_path`, `statement_timeout` and `idle_in_transaction_session_timeout` are set on connect. A transaction pooler in front of Postgres drops them. |

`warehousd deploy` checks all of this before it builds an image, as `db-*` lines in the pre-flight output:

```
✓ db-reachable        connected to db.abcdefghij.supabase.co:5432
✓ db-can-create-role  postgres may create roles
✓ db-extensions       vector, pgcrypto available on this server
✓ db-search-path      pgcrypto in "extensions" — reachable, or grantable by this role
✓ db-provider         Supabase on port 5432 — session pooler or direct
```

These run only when `database.url` is set. Under `managed: true` there is no database yet to ask. `warehousd doctor --deploy` runs the same lines without deploying anything.

### CREATEROLE through membership

`db-can-create-role` asks whether the connecting role has `CREATEROLE` or `SUPERUSER` **directly or through any role it inherits from**, not whether the attribute is set on the role itself. That distinction is the whole check on a hosted provider: Neon's `neondb_owner` has neither attribute and gets `CREATEROLE` through membership in `neon_superuser`, and RDS has the same shape with `rds_superuser`. Reading the role's own attributes refused every correctly configured Neon project.

One caveat, stated rather than hidden: stock Postgres does not confer `CREATEROLE` through membership — role attributes are not inherited — so on a vanilla server this check can pass for a role that would still fail at boot. It errs toward not blocking on purpose. The providers this matters for patch exactly this behaviour, and the release command still catches the genuine failure; refusing every Neon deployment up front does not.

### db-search-path on a first deploy

`db-search-path` decides on capability, not on the roles that happen to exist. On a database that has never booted there are no `warehousd_*` roles yet, so "which of them lack usage on the extension schema" is a question with no rows — and the check used to read that as a pass. It now refuses unless the connecting role owns the schema, or `PUBLIC` already holds usage on it (which a role created later inherits).

That is the run where the answer matters. After the first boot, `ensureExtensionSearchPath` has already done the work.

## Extensions outside `public`

On a local Postgres `create extension` puts everything in `public`, which every role already reaches. A hosted Postgres often does not: Supabase ships `pgcrypto` preinstalled in a schema called `extensions`, which makes `create extension if not exists pgcrypto` a silent no-op.

The failure mode is the bad one — `apply` succeeds, boot succeeds, and the first masked read fails at request time with `internal_error`. So warehousd handles this at apply time: it reads back where the extensions actually landed, grants the warehousd roles usage on those schemas, and puts them on each role's `search_path` for that database only.

That needs the connecting role to either already have the grant or be able to make it — which is what `db-search-path` checks for. If it refuses, connect as the role that owns the schema, or grant usage by hand and deploy again.

## The provider key

`provider` answers one of two questions, depending on the company it keeps.

**Alongside `url`, it names who *hosts* the database you attached.** It is only ever an override there: the hostname normally says so, and `generic` — plain role names, no provider-specific checks — is the fallback for anything unrecognised, which is exactly how every URL behaved before this key existed. Set it when the host does not advertise the provider: a CNAME onto your own domain, or a proxy in front.

**Alongside `managed: true`, it names who should *create* it.** Only `supabase` and `neon` can; `generic` names no CLI, and `railway` is refused because under `deploy.target: railway` the target already provisions one and a second route would be a second database. `region` is required in this shape and is the *database's* region — Supabase's `sa-east-1`, Neon's `aws-sa-east-1` — which is not the deploy target's `gru` or `us-west2`. `org` is Supabase's, and only needed when the account has more than one.

Getting it wrong is not a parse error; it is a role that cannot authenticate. So `db-provider` refuses a value the host contradicts — `provider: supabase` on a `*.neon.tech` url — naming both:

```
✗ db-provider  warehousd.yml says provider: supabase (Supabase), but
               ep-cool-1.eu-central-1.aws.neon.tech:5432 is a Neon host. Role names are
               derived per provider, so the wrong one produces a role that cannot
               authenticate. Set provider: neon, or drop the key and let the host decide.
```

A value set over a host nothing recognises stays valid, and is left alone — that is the CNAME case the key exists for, and the only one where you know more than the hostname does.

`warehousd init --db-provider <id>` writes the key, alongside the `--target` that gives it a block to sit in. It is worth setting there even when the host would be recognised: at scaffold time the url is still a `${env:…}` reference, so there is no host to read it off yet.

| Value | Host patterns | What differs |
| --- | --- | --- |
| `supabase` | `*.supabase.co`, `*.pooler.supabase.com` | Role names carry the project ref through the pooler; the transaction pooler is refused |
| `neon` | `*.neon.tech` | Advises `sslmode=require` |
| `railway` | `*.railway.app`, `*.rlwy.net`, `*.railway.internal` | Nothing — plain container, superuser owner |
| `generic` | everything else | Nothing |

## Supabase

`provider: supabase` under `managed: true` has warehousd run `supabase projects create` for you, generate the database password, and build the connection string. It uses the **session pooler on 5432** — `postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres`. That string is assembled rather than read: no Supabase CLI command prints a project's Postgres URL, so the host and port are warehousd's assumption about somebody else's product. `db-reachable` in the pre-flight is what catches it being wrong, before an image is built.

When you paste one yourself, the rule is the same:

**Use the session pooler or the direct connection. Not the transaction pooler.** In the Supabase dashboard, Connect → the string on port `5432`, not the one on `6543`.

`warehousd deploy` refuses `:6543` outright. The reason is that warehousd sets three connection startup parameters — `search_path` for the auth schema, and `statement_timeout` / `idle_in_transaction_session_timeout` as the ceilings on a pathological query — and the transaction pooler does not honour them. Those timeouts are deliberately pool-level rather than per-request `set` statements: a ceiling you can forget to apply is not a ceiling. The transaction-scoped `set_config` the broker uses for org isolation *would* have been pooler-safe, so this is a single blocker rather than a fundamental one, and it may be revisited.

The other Supabase-specific thing is the username. Through Supavisor one pooler fronts every project in a region, and the username is how it knows which: `postgres.<project_ref>`. So "the same database, as `warehousd_dev`" is spelled `warehousd_dev.<project_ref>`, not `warehousd_dev` — and a bare role name authenticates as nobody. All of which warehousd derives for you from the URL you give it; the `supabase` provider is what makes it happen.

Connect as the project's `postgres` role. It has `CREATEROLE`, and it owns the `extensions` schema, which is what lets the apply grant usage on it.

## Neon

`provider: neon` under `managed: true` runs `neon projects create --output json` and takes the connection URI straight out of the response — nothing is derived, which makes this the more predictable of the two. `?sslmode=require` is appended so a warehousd-created project passes the check below on its first run.

When you paste one yourself: add `?sslmode=require` to the URL. Neon's proxy negotiates TLS regardless, so this is about your client refusing a downgrade rather than about today's connection being in the clear; the pre-flight says so rather than refusing.

Connect as `neondb_owner` (or whichever role owns the database). It has no `CREATEROLE` attribute of its own — it is a member of `neon_superuser`, which is where the privilege comes from, and `db-can-create-role` asks the inherited question for exactly this reason. Roles created through SQL are not members of `neon_superuser`, which is fine: the four warehousd roles never need to own anything, only the grants boot hands them.

A Neon endpoint that has scaled to zero takes a few seconds to wake. Boot waits up to 60s for Postgres to answer, so a suspended endpoint is a slow first request, not a failed deploy.

## Railway

A Railway Postgres is a plain container whose `POSTGRES_USER` is a real superuser, with no pooler in front of it. Nothing about it differs from a local Postgres: plain role names, `create role` and `create extension` both work, and there are no provider-specific pre-flight checks.

Use `DATABASE_PUBLIC_URL` (the `*.rlwy.net` proxy) when warehousd runs elsewhere; `DATABASE_URL` (`*.railway.internal`) only resolves from inside Railway's private network, which also means the pre-flight cannot reach it from your machine.

## Anything else

`generic` is the fallback and it is not a downgrade — it is what every deployment did before providers existed. The role URLs are derived by swapping the username, and the four capability checks above still run. Everything in the requirements table at the top applies unchanged: `CREATEROLE` on the connecting role, `vector` and `pgcrypto`, `postgres_fdw` if you declare `sources:`, and **no transaction pooler in front**, because the three connection startup parameters warehousd sets would be dropped.

One caveat that lands here rather than under Neon, where it is discussed: on a stock Postgres `CREATEROLE` is not conferred through role membership, so `db-can-create-role` can pass for a role that still fails at boot. It errs toward not blocking, and the release command catches the real failure.

Adding a provider is one file in `packages/broker/src/db/providers/` for how its role names and checks work. Teaching warehousd to *create* a database there is a second file in `packages/cli/src/db/hosts/` plus a `provisions: true` flag on the first — the two registries are held in step at compile time, so a flag with no host does not build.

## Verifying the wall

The point of getting role derivation right is that the database, not the broker, refuses a cross-environment read. Confirm it after the first deploy — a subtly wrong derivation shows up here as an **allow** and nowhere else:

```bash
# as warehousd_dev, against live data — must be `permission denied`
psql "$DEV_ROLE_URL" -c 'select * from data_live.people limit 1'

# as warehousd_live, against synthetic data — same
psql "$LIVE_ROLE_URL" -c 'select * from data_synth.people limit 1'
```

Then exercise a masked read and a `search_documents` call, which are what prove `hmac()` and the `vector`/`<=>` operators resolve for those roles on a provider that installed the extensions outside `public`.
