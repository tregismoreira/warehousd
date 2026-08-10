# Deploying to Fly.io

End-to-end walkthrough of provisioning a warehousd stack to Fly.io and connecting Claude to it.

To deploy to Railway instead, see [deploy-railway.md](deploy-railway.md); to run the stack on hardware you control, [deploy-compose.md](deploy-compose.md). `deploy.target` is what chooses between the three.

## Prerequisites

- A Fly account. [Sign up free](https://fly.io).
- `flyctl` installed and authenticated:
  ```bash
  brew install flyctl
  flyctl auth signup  # or flyctl auth login
  ```
- Docker installed locally (only needed for `--local-build`).

The database does not have to be Fly's. `deploy.database` can name Supabase or Neon and warehousd will create the project itself — see [deploy-database.md](deploy-database.md).
- An SSO provider configured (OIDC or SAML), or willingness to run with local login enabled. SSO is documented in [configure-sso.md](configure-sso.md).

## Steps

### 1. Add the deploy config to warehousd.yml

Edit `examples/harbor/warehousd.yml` to add a `deploy:` block. On a new project `warehousd init --target fly` scaffolds this same block for you:

```yaml
deploy:
  target: fly
  app_name: harbor-warehousd
  region: gru
  database:
    managed: true
```

The app name must match `^[a-z0-9][a-z0-9-]{0,62}$` (no capital letters or underscores) and is globally unique on Fly — you may need to adjust it. Region codes are [Fly's three-letter region slugs](https://fly.io/docs/reference/regions/); `gru` is São Paulo. The region is checked by pre-flight rather than by the config schema — a region that is not a Fly slug shows up as a failed `fly-region` check before anything is created, not as a YAML parse error.

If you already run a Postgres and want to attach it instead of letting Fly manage one, use:

```yaml
deploy:
  target: fly
  app_name: harbor-warehousd
  region: gru
  database:
    url: ${env:PROD_DATABASE_URL}
```

Either `managed: true` or `url: ${env:...}` is required — not both.

Pointing at a hosted Postgres — Supabase, Neon, Railway — needs a little more than the URL: read [deploy-database.md](deploy-database.md) first. It covers which connection string to copy (Supabase's transaction pooler will not work), and the `database.provider` key for a URL whose host does not say who runs it.

### 2. Confirm demo mode is off

`warehousd deploy` refuses to run if `demo: true` is set in the YAML **or** if `WAREHOUSD_DEMO=true` is in the environment:

```bash
# This should succeed (demo off in both places):
warehousd deploy

# This will fail:
WAREHOUSD_DEMO=true warehousd deploy
```

### 3. Configure SSO or enable local login

The pre-flight checks require one of two paths:

**Option A: Use an SSO provider (recommended for production)**

Set the three environment variables your provider issues:

```bash
export SSO_ISSUER="https://your-idp.com"
export SSO_CLIENT_ID="..."
export SSO_CLIENT_SECRET="..."
warehousd deploy
```

OIDC and SAML are both supported. See [configure-sso.md](configure-sso.md) for a full walkthrough.

**Option B: Enable local login**

For development, pass `--allow-local-login`:

```bash
warehousd deploy --allow-local-login
```

This creates an admin account `admin@<app_name>.fly.dev` with a generated password. The deploy summary shows it masked — run `warehousd secrets --show` for the plaintext, or read `.warehousd/state.json` (mode 0600). Local login works without an IdP.

### 4. Build the image locally (temporary step)

The server image is not yet published. Until it is, build it locally:

```bash
docker build --platform linux/amd64 -f apps/web/Dockerfile -t warehousd:local .
```

`--platform` matters on Apple Silicon: Fly machines are amd64, and a default arm64 build fails the deploy with "no match for platform in manifest". If the emulated build segfaults under QEMU, enable Rosetta in Docker Desktop's settings, or build once on Fly's own builder and reference the pushed image:

```bash
flyctl deploy --config fly.toml --build-only --push --image-label base \
  --dockerfile apps/web/Dockerfile .
```

This takes a few minutes the first time. Once built, Fly caches it.

### 5. Run deploy

```bash
warehousd deploy --local-build
```

The `--local-build` flag tells the deploy to use the locally built image rather than trying to pull a published one. Once the image is published to GHCR, you can drop this flag and the `image:` override from the YAML.

**First deploy:**

- Fly creates the app.
- Postgres is provisioned (if `managed: true`).
- Secrets are set via stdin (no command-line storage).
- The image layer is built and pushed.
- The release command runs (migrations, seeding).
- The server starts and health checks pass.

Watch the logs live:

```bash
flyctl logs -a harbor-warehousd
```

### Health checks

The generated `fly.toml` points Fly at `/api/health` every 15 seconds, with a 5-second timeout and a 30-second grace period after boot. The endpoint is unauthenticated on purpose — Fly's checker has no session — and answers only `{"ok":true}` or a 503, never anything about why.

The grace period covers process start, not schema work: migrations run in the release command, on a one-off machine, before this one takes traffic. A migration that fails aborts the deploy and leaves the previous release serving.

`deploy` also polls the same endpoint once itself, so a deploy that returns cleanly has been answered at least once. The check is what keeps watching afterwards.

A machine that goes unhealthy after a successful deploy is almost always the database rather than the app — `/api/health` returns 503 when it cannot reach Postgres:

```bash
flyctl status -a harbor-warehousd            # which machines are failing the check
flyctl logs -a harbor-warehousd              # what they said on the way down
flyctl postgres list                         # is the database itself up
```

**Re-deploy:**

A diff is printed first, showing what changed:

```
Posture changes:
─ people.email: allow → deny (read)

Deploy y/n (without --yes)?
```

Type `y` to proceed, or use `--yes` to skip the prompt.

### 6. Verify the deployment

Once deploy succeeds, `.warehousd/outputs.deploy.json` contains the server URLs:

```bash
cat .warehousd/outputs.deploy.json
```

```json
{
  "apiUrl": "https://harbor-warehousd.fly.dev",
  "mcpUrl": "https://harbor-warehousd.fly.dev/mcp",
  "adminUrl": "https://harbor-warehousd.fly.dev/admin",
  "databaseUrl": null,
  "env": "dev"
}
```

Visit the admin URL and log in. If you used local login, the password was printed during deploy. If you used SSO, sign in through your IdP.

### 7. Verify data isolation

The deploy seeds synthetic data (`data_synth`) only, and never ships a collection's `source_live` directory into the image, so nothing can populate `data_live` during boot. Confirm it directly:

```bash
fly postgres connect --app <app_name>-db
# then, for each file collection:
select count(*) from data_live."policies__files";
```

Every count should be `0`.

> **Known limitation — the admin import path is not yet configured on a deployed instance.** `data_live` is written only by the admin import, which needs the `warehousd_import` role and `IMPORT_DATABASE_URL`. The container bootstrap (`ensureSchemasAndRoles`) provisions the four read/write data roles but not `warehousd_import`, and no container path sets that variable, so `POST /api/admin/import` answers `503 import_not_configured`. This predates `warehousd deploy` and affects `warehousd start` identically. Until it is fixed, a deployed instance can serve synthetic data but has no supported way to receive real data.

### 8. Connect Claude

In Claude:

1. Settings → Connectors → Add custom connector.
2. Paste the `mcpUrl` from `.warehousd/outputs.deploy.json`.
3. Complete the OAuth sign-in (through your IdP if SSO, local if enabled).
4. Claude can now query the data through warehousd.

See [connect-claude.md](connect-claude.md) for details.

## Re-deploying with posture changes

If you edit the schema in `warehousd.yml` — changing field access, adding collections, or binding taxonomies — the next deploy shows the diff:

```bash
# Edit warehousd.yml to deny the email field:
warehousd deploy
```

```
Posture changes:
─ people.email: allow → deny (read)
+ people.phone: (new, allow read)

Other changes:
~ people: description updated

Deploy y/n?
```

Posture changes (field access) are listed first. Approve with `y` or `--yes`.

## Backups

Fly Postgres takes daily volume snapshots and keeps them for a limited window (five days by default). They are the only copy of anything here, so treat the retention window as the real recovery limit.

```bash
flyctl volumes list -a harbor-warehousd-db
flyctl volumes snapshots list <volume-id>
```

**What is worth recovering, in order.** Not everything in the database costs the same to lose:

| Data | If lost | Why |
|---|---|---|
| `app.grants`, `app.audit_events`, `app.change_log` | **Unrecoverable** | Who approved what, who read what, and when. Nothing can regenerate a decision history. |
| `app.client_policies`, `app.client_secrets`, `app.trusted_issuers` | Re-issue | Credentials can be recreated; every integration has to be re-pointed. |
| `data_live` | Re-import | The customer's own data, with its own upstream and an append-only import path. |
| `data_synth` | Regenerate | `warehousd regen-synth` rebuilds it from the config with a fixed seed. |

The audit trail is the one to plan around: the application cannot prune it by design (see [architecture.md](architecture.md#the-app-schema)), so it grows without bound and your snapshots grow with it. Budget for that rather than discover it.

**A restore is not a backup until it has been restored.** Test it against a throwaway app rather than against the deployment you care about:

```bash
flyctl postgres create --name harbor-restore-test --snapshot-id <snapshot-id>
```

Then point a scratch deploy at it and confirm the three things worth confirming: `app.schema_migrations` lists every migration, `select count(*) from app.audit_events` is non-zero, and an approved grant still resolves. Destroy the restore app afterwards — it holds a full copy of live data.

## Tearing down the deployment

To destroy the app and its database:

```bash
warehousd deploy --destroy
```

You must type the app name exactly (e.g. `harbor-warehousd`) — there is no `--yes` bypass. This prevents accidental teardown.

```
Type app name to confirm destroy:
harbor-warehousd
Destroying app and database...
```
