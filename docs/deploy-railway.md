# Deploying to Railway

End-to-end walkthrough of provisioning a warehousd stack to Railway. It is the
same runbook as [deploy-fly.md](deploy-fly.md) — same pre-flight, same secrets,
same diff-and-confirm — with a different target behind it. This page covers only
what differs. To run the stack on hardware you control instead, see
[deploy-compose.md](deploy-compose.md); `deploy.target` is what chooses between
the three.

## Prerequisites

- A Railway account. [Sign up](https://railway.com).
- The `railway` CLI, installed and authenticated:
  ```bash
  npm i -g @railway/cli     # or: brew install railway
  railway login             # or export RAILWAY_TOKEN=... for CI
  ```
- An SSO provider configured (OIDC or SAML), or willingness to run with local
  login enabled. SSO is documented in [configure-sso.md](configure-sso.md).

Docker is **not** a prerequisite. Railway builds remotely, always — there is no
equivalent of `flyctl deploy --remote-only` to opt out of, and `--local-build`
does nothing on this target.

## 1. Add the deploy config

On a new project `warehousd init --target railway` scaffolds this block for you.

```yaml
deploy:
  target: railway
  app_name: harbor-warehousd
  region: us-west2
  database:
    managed: true
```

`app_name` names three things at once: the Railway **project**, the **service**
inside it that runs warehousd, and the hostname the generated domain is built
from. It must match `^[a-z0-9][a-z0-9-]{0,62}$` — the same rule every target
applies, because every target turns it into a DNS label.

`region` takes a [Railway region code](https://docs.railway.com/reference/deployment-regions)
— `us-west2`, `us-east4`, `europe-west4`, `asia-southeast1` — not a Fly
three-letter slug. The shape is checked by pre-flight rather than by the config
schema, so a wrong one is a failed `railway-region` check before anything is
created, not a YAML parse error.

To attach a Postgres you already run instead, replace `managed: true` with a
`url:`, and read [deploy-database.md](deploy-database.md) first:

```yaml
deploy:
  target: railway
  app_name: harbor-warehousd
  region: us-west2
  database:
    url: ${env:PROD_DATABASE_URL}
```

## 2. Pre-flight

`warehousd deploy` runs the shared checks (demo mode off, audit on, SSO or
`--allow-local-login`, migrations for destructive changes) and three of its own:

| Check | Asks |
| --- | --- |
| `railway-ready` | Is the CLI installed, and is this session authenticated? |
| `railway-region` | Is `deploy.region` a Railway region code? |
| `railway-project` | Is this directory linked to a project other than `app_name`? |

The third is the one worth understanding. Every `railway` subcommand acts on the
**linked** project — a file in the working directory, not a flag — so a
directory linked by hand to something else would take the whole deploy with it
and never mention `app_name`. Nothing linked is fine; that is a first deploy.
A mismatch is refused:

```
x  railway-project  this directory is linked to the Railway project "scratch",
                    but deploy.app_name is "harbor-warehousd". Run `railway
                    unlink`, or change app_name to match.
```

None of the three mutate anything. `warehousd doctor` runs them too.

## 3. Deploy

```bash
warehousd deploy --allow-local-login
```

What happens, in order:

1. **`railway init --name <app_name>`**, then **`railway add --service
   <app_name>`** — unless a project is already linked and already has that
   service. Both are idempotent; a redeploy creates neither.
2. **`railway add --database postgres`**, under `managed: true` only. Railway's
   Postgres is a plain container whose `POSTGRES_USER` is a real superuser, so
   `create role` and `create extension` work with no special handling and there
   is no pooler in front of it to drop connection startup parameters.
   warehousd reads `DATABASE_URL` back off that service and sets it as
   `APP_DATABASE_URL` on the app — preferring the private
   `*.railway.internal` hostname, which skips the public proxy and its egress,
   and falling back to `DATABASE_PUBLIC_URL`. Provisioning is asynchronous on
   Railway's side, so that read is retried for up to 30s before it is treated as
   a database that failed to come up.
3. **`railway domain --port 8722 --json`** — generates the public hostname if
   the service has none, which is what `BETTER_AUTH_URL` and the health poll
   need. The port is passed explicitly because this runs *before* the deploy —
   `BETTER_AUTH_URL` has to be in the secrets the release reads — so there is no
   running deployment for Railway to infer one from, and without it a first
   deploy got no domain at all. The `--json` body is what warehousd reads; the
   printed line is a fallback for older CLI versions, and `RAILWAY_PUBLIC_DOMAIN`
   is read back for a service that already had one.
4. **`railway variables --set …`** — the generated secrets, plus `PORT`,
   `WAREHOUSD_PROJECT_DIR` and `NODE_ENV`. Fly gets those three from `fly.toml`'s
   `[env]`; Railway has no equivalent file, so they travel the same channel.
   `WAREHOUSD_DEMO` is deliberately never set — its absence is what keeps demo
   personas from being seeded.
5. **`railway up --detach`** — uploads `.warehousd/deploy`, which holds the
   generated `Dockerfile`, the rendered `railway.json`, and the project bundle.
6. warehousd polls `/api/health` until it answers.

### Secrets travel in argv

`railway variables --set K=V` is the only way the CLI sets a variable, and it
has no stdin or file equivalent — unlike `flyctl secrets import --stage`, which
is why the Fly path keeps every credential off the command line. So on Railway,
for the moment the deploy runs, the generated secrets are visible in the process
table of the machine running it.

What warehousd can contain, it does: `--verbose` prints `BETTER_AUTH_SECRET=***`
rather than the value, and a failed `variables` call throws a message with the
CLI's stderr stripped out, because Railway echoes the assignment it could not
apply. What it cannot contain is a shared or untrusted deploy machine. Deploy
from one you control, or from CI where the runner is ephemeral.

### The release command

Fly runs the bootstrap as a `release_command` on a one-off machine before the
new release takes traffic, so a failed migration aborts the deploy and the
previous release keeps serving. Railway has no equivalent, so the image's own
`CMD` is left alone: the container runs the entrypoint and then serves, in that
order, in one process. A failed migration is therefore a container that does not
come up, caught by the health check rather than before the cutover.

### The rendered railway.json

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "Dockerfile" },
  "deploy": {
    "healthcheckPath": "/api/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "multiRegionConfig": { "us-west2": { "numReplicas": 1 } }
  }
}
```

It is this target's `fly.toml`, generated per deploy and not checked in.
`healthcheckPath` is what keeps watching after the deploy returns — warehousd
polls `/api/health` once itself and then stops looking, so without it nothing
notices a container that wedges an hour later. `multiRegionConfig` is the only
place `deploy.region` can take effect; Railway has no `--region` flag on any CLI
command.

## 4. Verify

`.warehousd/outputs.deploy.json` holds the URLs, exactly as on Fly:

```json
{
  "apiUrl": "https://harbor-warehousd-production.up.railway.app",
  "mcpUrl": "https://harbor-warehousd-production.up.railway.app/mcp",
  "adminUrl": "https://harbor-warehousd-production.up.railway.app/admin",
  "databaseUrl": null,
  "env": "dev"
}
```

Then confirm the wall the deployment exists to enforce — a role derivation that
is subtly wrong shows up here as an **allow** and nowhere else:

```bash
railway connect Postgres          # psql against the managed database
select count(*) from data_live."policies__files";   # every count should be 0
```

[deploy-database.md](deploy-database.md#verifying-the-wall) has the full check,
including the cross-environment reads that must come back `permission denied`.

The same known limitation applies as on Fly: the admin import path is not yet
configured on a deployed instance, so `data_live` has no supported way to
receive real data. See [deploy-fly.md](deploy-fly.md#7-verify-data-isolation).

## Logs and status

```bash
railway logs --service harbor-warehousd
railway status
railway open                      # the project in the dashboard
```

A service that goes unhealthy after a successful deploy is usually the database
rather than the app — `/api/health` answers 503 when it cannot reach Postgres.

## Backups

**Railway does not back up a database service by default.** A managed Postgres
here is a container with a volume, and the volume is the only copy. Enable
backups on the Postgres service in the dashboard before the deployment holds
anything you would miss, and read
[deploy-fly.md](deploy-fly.md#backups) for what is worth recovering and in what
order — the audit trail is the part nothing can regenerate.

## Tearing down

```bash
warehousd deploy --destroy
```

Type the app name to confirm; there is no `--yes` bypass. This deletes the whole
Railway **project**, which is the unit the deploy created — the app service and
the managed Postgres go with it. If the directory is linked to a project the
config does not name, it refuses rather than deleting someone else's work.
