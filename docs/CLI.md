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

Initialize a new warehousd project in the current directory.

```bash
warehousd init [project-name]
```

Creates:
- `warehousd.yml`: Configuration file (YAML schema for collections, taxonomies, grants, synthetic data)
- `seed/docs-dev/`: Example policy documents for development
- `seed/docs-live/`: Example policy documents for production
- `.warehousd/`: State directory (git-ignored)

**Flags:**
- `--db`: Custom Postgres URL (defaults to `postgres://postgres:postgres@127.0.0.1:5432/warehousd`)

### start

Start the warehousd server and database.

```bash
warehousd start
```

Spawns a Docker container running the web server (Next.js) and Postgres. Prints the outputs contract to stdout.

**Flags:**
- `--db`: Bring-your-own Postgres URL (e.g., `postgres://user:pw@host:5432/db`)
- `--image`: Override the container image (defaults to `ghcr.io/warehousd/warehousd:VERSION`)
- `--offline`: Require the image to exist locally; fail if a pull is needed

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
- `devClient`: Object with `id` and `secret` (OAuth client for programmatic access)
- `env`: Environment name (`dev` or `live`)

### stop

Stop the running warehousd container and optionally destroy the database.

```bash
warehousd stop [--destroy] [--yes]
```

**Flags:**
- `--destroy`: Remove the Postgres container and volume (irreversible data loss)
- `--yes`: Skip confirmation prompt when using `--destroy`

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

Apply a Postgres migration or configuration change (Advanced).

```bash
warehousd apply <sql-file>
```

Executes SQL against the app schema. Used to modify collections, grants, or other app-layer configurations.

### seed

Seed or regenerate synthetic data (Advanced).

```bash
warehousd seed [collection-name]
```

Regenerates synthetic data for a collection (or all collections if not specified). Useful after adding new fields or changing `synthetic` config.

### index

Index file collections for search (Advanced).

```bash
warehousd index <collection-name>
```

Re-index a file collection (e.g., policies, docs). Called automatically during `start`.

### regen-synth

Regenerate all synthetic data without restarting the server.

```bash
warehousd regen-synth [--seed <number>]
```

**Flags:**
- `--seed`: PRNG seed for reproducible synthetic data (default: 42)

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
      "id": "...",
      "secret": "..."
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

The CLI will skip Docker entirely and connect directly to your database.

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
warehousd init my-project
cd my-project
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
# Connect to a remote Postgres instance
warehousd init --db postgres://admin:secret@db.example.com:5432/mydb
warehousd start  # Uses the configured database, no Docker container
```

## Architecture

The CLI orchestrates three main components:

1. **Docker container**: Runs the web server (Next.js) and optionally a Postgres database
2. **Better Auth**: Handles user authentication (email/password and OAuth)
3. **Warehousd broker**: Enforces access control, synthetic data generation, and indexing

For more details, see `docs/SETUP.md` and `docs/SPECS.md`.
