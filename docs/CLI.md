# warehousd CLI Reference

The `warehousd` CLI is a Node.js command-line tool for managing Postgres-backed data projects. It handles initialization, lifecycle management (start/stop), and configuration.

## Installation

```bash
npm install -g warehousd
# or
npx warehousd
```

## Commands

### init

Initialize a new warehousd project.

```bash
warehousd init
```

Creates:
- `warehousd.yml`: Configuration file (YAML schema for collections, taxonomies, synthetic data)
- `.gitignore` entries for `warehousd.local.yml` and `.warehousd/` (the file is created if absent)

`init` does not create seed directories or `.warehousd/` — the latter is created by `start`.

**Flags:**
- `-d, --dir <dir>`: Project directory (default: current working directory)
- `--force`: Overwrite an existing `warehousd.yml`

### start

Start the warehousd server and database.

```bash
warehousd start
```

Spawns a Docker container running the web server (Next.js), plus a managed
Postgres container unless `database.url` is set in `warehousd.yml`. Prints the
outputs contract to stdout and writes `.warehousd/outputs.json`.

**Flags:**
- `-d, --dir <dir>`: Project directory (default: current working directory)
- `-s, --seed <n>`: Synthetic data PRNG seed (default: `42`)
- `--verbose`: Log every Docker command

**Image selection** (no CLI flag; resolved in this order):
1. `server.image` in `warehousd.yml`
2. `WAREHOUSD_IMAGE` environment variable
3. `ghcr.io/tregismoreira/warehousd:<cli-version>`

**Offline behaviour** is automatic: images are only pulled when
`docker image inspect` fails, so once an image is local, `start` never touches
the network. See `docs/runbooks/offline-start.md`.

**Output:**
Prints a structured block with the six-key outputs contract:

```
═══════════════════════════════════════════════════════════
warehousd is running
═══════════════════════════════════════════════════════════

MCP Server:
  http://localhost:8722/mcp

API Server:
  http://localhost:8722

Admin UI:
  http://localhost:8722/admin

Database:
  postgres://warehousd:PASSWORD@localhost:PORT/warehousd

Environment:
  dev

Dev Client:
  ID:     <oauth-client-id>
  Secret: <oauth-client-secret>

Admin Login:
  Email:    admin@warehousd.local
  Password: <random-password>

═══════════════════════════════════════════════════════════
```

The six outputs contract keys are:
- `apiUrl`: Web server base URL (e.g., `http://localhost:8722`)
- `mcpUrl`: MCP server URL (same base URL with `/mcp` path)
- `databaseUrl`: Postgres connection string (read-write for admin tasks, read-only for data)
- `adminUrl`: Admin UI URL (`apiUrl/admin`)
- `devClient`: Object with `clientId` and `clientSecret` (OAuth client for programmatic access)
- `env`: Environment name (`dev` or `live`)

### stop

Stop the running warehousd container and optionally destroy the database.

```bash
warehousd stop [--destroy] [--yes]
```

**Flags:**
- `-d, --dir <dir>`: Project directory (default: current working directory)
- `--destroy`: Remove the Postgres container and volume (irreversible data loss)
- `--yes`: Required with `--destroy`. There is no interactive prompt; without
  `--yes`, `--destroy` exits with an error rather than asking.

### status

Check if the warehousd container is running.

```bash
warehousd status
```

Returns:
- Exit code 0 if running
- Exit code 1 if stopped or not found
- Prints container health and URL

### apply

Apply the `warehousd.yml` config to the database — creates schemas, tables, and
`v_<collection>` views (Advanced). Runs against the host, not the container.

```bash
warehousd apply
```

**Flags:**
- `-d, --dir <dir>`: Project directory (default: current working directory)
- `--db <url>`: Database URL (falls back to `DATABASE_URL`, then `.warehousd/outputs.json`)

### seed

Generate synthetic data for all data collections (Advanced).

```bash
warehousd seed
```

**Flags:**
- `-d, --dir <dir>`: Project directory (default: current working directory)
- `--db <url>`: Database URL
- `-s, --seed <n>`: PRNG seed (default: `42`)

### index

Index a file collection for search (Advanced).

```bash
warehousd index <collection>
```

Re-index a file collection (e.g., policies, docs). Called automatically during `start`.

**Flags:**
- `-d, --dir <dir>`: Project directory (default: current working directory)
- `--db <url>`: Database URL
- `--env <env>`: `dev` or `live` (default: `dev`)
- `--source <dir>`: Override the source directory

### regen-synth

Regenerate all synthetic data without restarting the server.

```bash
warehousd regen-synth [-s <number>]
```

**Flags:**
- `-d, --dir <dir>`: Project directory (default: current working directory)
- `--db <url>`: Database URL
- `-s, --seed <n>`: PRNG seed for reproducible synthetic data (default: `42`)

## .warehousd/ Directory Layout

The `.warehousd/` directory is created by `init` and contains state and outputs. It should be added to `.gitignore`.

- **state.json**: Secrets only (passwords, OAuth secrets). Never commit.
  ```json
  {
    "dbPassword": "...",
    "dataRolePassword": "...",
    "betterAuthSecret": "...",
    "adminPassword": "..."
  }
  ```

- **outputs.json**: The outputs contract (URLs, IDs, connection strings). Never commit.
  ```json
  {
    "apiUrl": "http://localhost:8722",
    "mcpUrl": "http://localhost:8722/mcp",
    "databaseUrl": "postgres://warehousd:PASSWORD@localhost:PORT/warehousd",
    "adminUrl": "http://localhost:8722/admin",
    "devClient": {
      "clientId": "...",
      "clientSecret": "..."
    },
    "env": "dev"
  }
  ```

## Configuration (warehousd.yml)

### Minimal Example

```yaml
project: my-project
server: { port: 8722 }
database: { port: 5432 }
demo: false

collections:
  announcements:
    description: Company announcements
    fields:
      id:    { type: uuid, posture: allow, pk: true }
      title: { type: text, posture: allow }
  policies:
    type: file
    description: Policy documents
    source: ./seed/docs-dev
    fields:
      title:   { posture: allow }
      content: { posture: allow }

synthetic:
  documents_per_collection: { announcements: 10 }
```

### Demo Mode

Set `demo: true` to seed demo login credentials on startup:
- Email: `ana@demo.local`, Password: `demo`, Role: `admin`
- Email: `marcus@demo.local`, Password: `demo`, Role: `manager`
- Email: `mia@demo.local`, Password: `demo`, Role: `member`

The login page will show buttons for these personas.

### Bring-Your-Own Postgres

To use an existing Postgres instance instead of the Docker container:

```yaml
database:
  url: postgres://user:password@host.example.com:5432/warehousd_prod
```

Then run:

```bash
warehousd start
```

The CLI skips the managed Postgres container and points the server at your
database instead. The server itself still runs as a Docker container, and
`stop --destroy` will not touch a database it does not manage.

## Troubleshooting

### "Docker is not running"

```
DockerError: Docker is installed but the daemon isn't reachable. Start Docker and retry.
```

**Fix:** Open Docker Desktop or start the Docker daemon, then retry.

### "Port already in use"

```
Error response from daemon: port is already allocated
```

**Fix:** Either:
1. Use a different port: Update `server.port` in `warehousd.yml` and retry.
2. Kill the existing process: `docker stop wh_<project>_server && docker rm wh_<project>_server`, then retry.

### Server starts but times out or is unresponsive

Check container logs:

```bash
docker logs wh_<project>_server --tail 100
```

Common issues:
- Postgres not ready: Wait 10s and check logs again
- Schema migration failed: Look for SQL errors in the logs
- Better Auth migration failed: Ensure `BETTER_AUTH_SECRET` is set and valid

### "outputs.json not found"

The outputs are printed to stdout during `start`. If you need them again:

```bash
warehousd status  # prints the URLs
cat .warehousd/outputs.json  # if the file exists
```

## Examples

### Example: Minimal Project

```bash
mkdir my-project && cd my-project
warehousd init
warehousd start
curl http://localhost:8722/api/health  # {"ok":true}
warehousd stop
```

### Example: Demo Mode

Edit `warehousd.yml`:
```yaml
demo: true
```

Then:
```bash
warehousd start
# Login page shows demo credential buttons
# ana@demo.local, marcus@demo.local, mia@demo.local
warehousd stop --destroy --yes
```

### Example: Custom Database

```bash
warehousd init
# then set database.url in warehousd.yml:
#   database:
#     url: postgres://admin:secret@db.example.com:5432/mydb
warehousd start  # Uses the configured database; no managed DB container
```

## Architecture

The CLI orchestrates three main components:

1. **Docker container**: Runs the web server (Next.js) and optionally a Postgres database
2. **Better Auth**: Handles user authentication (email/password and OAuth)
3. **Warehousd broker**: Enforces access control, synthetic data generation, and indexing

For more details, see `docs/SETUP.md` and `docs/SPECS.md`.
