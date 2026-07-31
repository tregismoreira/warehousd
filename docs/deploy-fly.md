# Deploying to Fly.io

End-to-end walkthrough of provisioning a warehousd stack to Fly.io and
connecting Claude to it.

## Prerequisites

- A Fly account. [Sign up free](https://fly.io).
- `flyctl` installed and authenticated:
  ```bash
  brew install flyctl
  flyctl auth signup  # or flyctl auth login
  ```
- Docker installed locally (only needed for `--local-build`).
- An SSO provider configured (OIDC or SAML), or willingness to run with local
  login enabled. SSO is documented in [configure-sso.md](configure-sso.md).

## Steps

### 1. Add the deploy config to warehousd.yml

Edit `examples/harbor/warehousd.yml` to add a `deploy:` block:

```yaml
deploy:
  target: fly
  app_name: harbor-warehousd
  region: gru
  database:
    managed: true
```

The app name must match `^[a-z0-9][a-z0-9-]{0,62}$` (no capital letters or
underscores) and is globally unique on Fly — you may need to adjust it. Region
codes are [Fly's three-letter region slugs](https://fly.io/docs/reference/regions/);
`gru` is São Paulo.

If you already run a Postgres and want to attach it instead of letting Fly
manage one, use:

```yaml
deploy:
  target: fly
  app_name: harbor-warehousd
  region: gru
  database:
    url: ${env:PROD_DATABASE_URL}
```

Either `managed: true` or `url: ${env:...}` is required — not both.

### 2. Confirm demo mode is off

`warehousd deploy` refuses to run if `demo: true` is set in the YAML **or** if
`WAREHOUSD_DEMO=true` is in the environment:

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

OIDC and SAML are both supported. See [configure-sso.md](configure-sso.md) for a
full walkthrough.

**Option B: Enable local login**

For development, pass `--allow-local-login`:

```bash
warehousd deploy --allow-local-login
```

This creates an admin account `admin@warehousd.local` with a generated password,
printed during deploy. Local login works without an IdP.

### 4. Build the image locally (temporary step)

The server image is not yet published. Until it is, build it locally:

```bash
docker build -f apps/web/Dockerfile -t warehousd:local .
```

This takes a few minutes the first time. Once built, Fly caches it.

### 5. Run deploy

```bash
warehousd deploy --local-build
```

The `--local-build` flag tells the deploy to use the locally built image rather
than trying to pull a published one. Once the image is published to GHCR, you
can drop this flag and the `image:` override from the YAML.

**First deploy:**

- Fly creates the app.
- Postgres is provisioned (if `managed: true`).
- Secrets are set via stdin (no command-line storage).
- The image layer is built and pushed.
- The release command runs (schema setup, seeding).
- The server starts and health checks pass.

Watch the logs live:

```bash
flyctl logs -a harbor-warehousd
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

Visit the admin URL and log in. If you used local login, the password was
printed during deploy. If you used SSO, sign in through your IdP.

### 7. Verify data isolation

The deploy seeds synthetic data (`data_synth`) only. Real data arrives only
through the admin import path. Confirm `data_live` is empty:

1. Log into the admin panel.
2. Navigate to **Import**.
3. No live documents should be present.

### 8. Connect Claude

In Claude:

1. Settings → Connectors → Add custom connector.
2. Paste the `mcpUrl` from `.warehousd/outputs.deploy.json`.
3. Complete the OAuth sign-in (through your IdP if SSO, local if enabled).
4. Claude can now query the data through warehousd.

See [connect-claude.md](connect-claude.md) for details.

## Re-deploying with posture changes

If you edit the schema in `warehousd.yml` — changing field access, adding
collections, or binding taxonomies — the next deploy shows the diff:

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

## Tearing down the deployment

To destroy the app and its database:

```bash
warehousd deploy --destroy
```

You must type the app name exactly (e.g. `harbor-warehousd`) — there is no
`--yes` bypass. This prevents accidental teardown.

```
Type app name to confirm destroy:
harbor-warehousd
Destroying app and database...
```
