# Deploying with Docker Compose

For running warehousd on hardware you control — your own server, a VM at any
provider, a machine behind a corporate firewall. `warehousd deploy` renders a
Compose file and an env file; **you** start the stack, and everything the other
targets get from a platform — TLS, restarts across reboots, backups — is yours.

This is the target to pick when the answer to "where does the data sit" has to
be "here". It is also the least automated one: nothing in this runbook creates
an account, and nothing warehousd runs ever touches the machine the stack runs
on. For a platform that does all of that for you, see
[deploy-fly.md](deploy-fly.md) or [deploy-railway.md](deploy-railway.md).

## Prerequisites

- Docker Engine 24+ with the Compose plugin (`docker compose version`) on the
  machine that will run the stack. It is **not** needed on the machine you run
  `warehousd deploy` from — that one only writes files.
- A way to terminate TLS in front of the server: Caddy, nginx, Traefik, a load
  balancer. See [Serving over TLS](#serving-over-tls) — this is not optional.
- An SSO provider configured (OIDC or SAML), or willingness to run with local
  login enabled. SSO is documented in [configure-sso.md](configure-sso.md).

## Steps

### 1. Add the deploy config to warehousd.yml

On a new project `warehousd init --target compose` scaffolds this block for you.
There is no `region` — Compose has no regions, and the schema does not ask for
one here. (Fly and Railway demand theirs at pre-flight instead.)

```yaml
deploy:
  target: compose
  app_name: harbor-warehousd
  database:
    managed: true
```

`app_name` becomes the Compose project name, which is what keeps two stacks on
one host from adopting each other's containers.

`managed: true` puts a `pgvector/pgvector:pg16` service in the rendered file,
with a named volume and a password generated into `.warehousd/state.json`. To
attach a database you already run — including a hosted one — use `url:`
instead, and read [deploy-database.md](deploy-database.md) first:

```yaml
deploy:
  target: compose
  app_name: harbor-warehousd
  database:
    url: ${env:PROD_DATABASE_URL}
```

With `url:`, no `db` service is rendered.

### 2. Run deploy

```bash
warehousd deploy --allow-local-login
```

The same pre-flight runs as for every other target — demo mode off, an audit
trail on, SSO or `--allow-local-login`, a migration for any destructive schema
change — and it refuses in the same way. What follows it is short, because
there is no platform to talk to:

| Written | What it is |
| --- | --- |
| `docker-compose.deploy.yml` | The stack. Regenerated on every deploy; keep your edits elsewhere. Contains no secrets, so it is safe to commit. |
| `.warehousd/deploy.env` | Every secret, mode 0600. **Never commit this.** `.warehousd/` is already in `.gitignore`. |
| `.warehousd/deploy/context/` | The bundle: `warehousd.yml`, your migrations and each collection's `source` directory. Never `source_live`. |

The summary ends with the command to start it. Nothing is running yet, and no
health check has been made — there is nothing to check.

### 3. Start the stack

On the machine that will run it, from the project directory:

```bash
docker compose --env-file .warehousd/deploy.env -f docker-compose.deploy.yml up -d
```

`--env-file` is required: the compose file interpolates `POSTGRES_PASSWORD`
from it rather than carrying the password itself. Without the flag, Compose
refuses to start rather than starting a database with an empty password.

Deploying from a different machine than the one that runs the stack means
copying three things across, together:

```bash
rsync -av --relative \
  docker-compose.deploy.yml .warehousd/deploy.env .warehousd/deploy/context \
  server:/srv/harbor/
```

The bundle is bind-mounted at `/project`, read-only. Nothing in the container
writes to it, and on Linux it must be readable by uid 1000 — a 0755 directory
is fine, a 0700 one owned by another user fails as `No warehousd.yml in
/project`.

Watch the bootstrap, which runs migrations and seeds synthetic data before the
server binds:

```bash
docker compose -f docker-compose.deploy.yml logs -f server
```

The first start takes a few minutes: the image is pulled, Postgres initialises,
and the entrypoint applies the config. `docker compose ps` shows `healthy` when
`/api/health` answers.

### 4. Serving over TLS

The server is published on `127.0.0.1:8722` — loopback only, deliberately.
Sessions, OAuth codes and tokens all cross that wire, and
[SECURITY.md](../SECURITY.md) is explicit that off the platform targets the
transport is the operator's responsibility.

Put a terminator in front of it. Caddy is two lines:

```caddyfile
warehousd.example.com {
  reverse_proxy 127.0.0.1:8722
}
```

Then tell warehousd the address it is served on, so that OAuth callbacks
resolve, by adding one line to `.warehousd/deploy.env` and restarting:

```bash
echo 'BETTER_AUTH_URL=https://warehousd.example.com' >> .warehousd/deploy.env
docker compose --env-file .warehousd/deploy.env -f docker-compose.deploy.yml up -d
```

The deploy omits `BETTER_AUTH_URL` rather than guessing it: with no platform
hostname to read, any value it invented would be wrong, and an empty one would
break every callback instead of falling back to the request. Until you set it,
browser sign-ins are accepted only from `http://localhost:<server.port>` — the
deploy writes that origin into `WAREHOUSD_TRUSTED_ORIGINS` in `deploy.env`, and
the sign-in origin gate refuses any other. Setting `BETTER_AUTH_URL` is what
makes your proxy's hostname a trusted origin too.

**If you widen the published port** to `0.0.0.0` and serve plaintext HTTP, you
are sending session cookies in the clear. Demo mode is refused by pre-flight;
this one nothing can refuse for you.

### 5. Verify the deployment

`.warehousd/outputs.deploy.json` records `http://localhost:8722` — the address
the compose file publishes, not the one your proxy serves:

```json
{
  "apiUrl": "http://localhost:8722",
  "mcpUrl": "http://localhost:8722/mcp",
  "adminUrl": "http://localhost:8722/admin",
  "databaseUrl": null,
  "env": "dev"
}
```

Then confirm the dev/live wall holds, which is the point of the whole system:

```bash
docker compose -f docker-compose.deploy.yml exec db psql -U warehousd warehousd
# then, for each file collection:
select count(*) from data_live."policies__files";
```

Every count should be `0`. The deploy never ships a collection's `source_live`
directory into the bundle, so nothing can populate `data_live` during boot.

Connect Claude with the `mcpUrl` — through your proxy's hostname, not
localhost. See [connect-claude.md](connect-claude.md).

## Re-deploying

`warehousd deploy` again renders both files afresh, showing the config diff and
asking for confirmation exactly as it does for Fly. Then apply it:

```bash
docker compose --env-file .warehousd/deploy.env -f docker-compose.deploy.yml up -d
```

Compose recreates only what changed. The bundle is a bind mount, so content
edits under a collection's `source` directory reach the container without a new
image — but the config is applied at boot, so a `warehousd.yml` change needs the
server container restarted.

## Backups

Nobody is taking them for you. The managed database lives in a named volume,
`<app_name>_pgdata`:

```bash
docker compose -f docker-compose.deploy.yml exec db \
  pg_dump -U warehousd -Fc warehousd > warehousd-$(date +%F).dump
```

What is worth recovering, in what order, is the same as for any other target —
[deploy-fly.md](deploy-fly.md#backups) has the table. The audit trail is the
part to plan around: it cannot be pruned by design, so it grows without bound
and your dumps grow with it.

A restore is not a backup until it has been restored. Test it into a scratch
database, not the one you care about.

## Tearing down

```bash
warehousd deploy --destroy
```

This one **prints** the teardown command rather than running it. The stack is on
your machine, possibly under a supervisor that would restart it, and a deploy
tool reaching that far is a deploy tool that can take down more than it made.
The confirmation prompt says so — it still asks for the app name, but it does
not claim it is about to destroy a database, because on this target it is not:

```bash
docker compose -f docker-compose.deploy.yml down
```

Add `--volumes` to delete the database with it — that is the irreversible half,
and there is no snapshot behind it. `docker-compose.deploy.yml` and
`.warehousd/deploy.env` are left in place; delete them by hand.
