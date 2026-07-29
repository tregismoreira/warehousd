# CLI reference

`warehousd` manages the lifecycle of a warehousd project: scaffolding the
config, running the server and its database, applying configuration, seeding
synthetic data, and indexing files.

You do not clone this repository to use it. Add a `warehousd.yml` to your own
app's repo and run the CLI there.

```bash
npx warehousd <command>
# or
npm install -g warehousd
```

Requires Docker and Node 22+.

## Commands

Every command takes `-d, --dir <dir>` to point at the project directory
(default: the current one).

### `init`

Scaffolds `warehousd.yml` and adds `warehousd.local.yml` and `.warehousd/` to
`.gitignore`, creating that file if it does not exist. It does not create seed
directories or `.warehousd/` — `start` does that.

| Flag | |
|---|---|
| `--force` | Overwrite an existing `warehousd.yml`. |

### `start`

Starts the server container, plus a managed Postgres container unless
`database.url` is set. Applies the config, seeds synthetic data, indexes file
collections, prints the outputs block, and writes `.warehousd/outputs.json`.
Idempotent — re-running picks up YAML changes.

| Flag | |
|---|---|
| `-s, --seed <n>` | Synthetic data PRNG seed (default `42`). |
| `--verbose` | Log every Docker command. |

The server image is resolved in this order: `server.image` in `warehousd.yml`,
then `WAREHOUSD_IMAGE`, then `ghcr.io/tregismoreira/warehousd:<cli-version>`.

```
═══════════════════════════════════════════════════════════
warehousd is running
═══════════════════════════════════════════════════════════

MCP Server:   http://localhost:8722/mcp
API Server:   http://localhost:8722
Admin UI:     http://localhost:8722/admin
Database:     postgres://warehousd:PASSWORD@localhost:PORT/warehousd
Environment:  dev
Dev Client:   ID: <oauth-client-id> / Secret: <oauth-client-secret>
Admin Login:  admin@warehousd.local / <generated password>
═══════════════════════════════════════════════════════════
```

### `stop`

Stops the containers, keeping volumes.

| Flag | |
|---|---|
| `--destroy` | Also remove the Postgres container and volume. Irreversible. |
| `--yes` | Required with `--destroy`. There is no interactive prompt — without `--yes`, `--destroy` exits with an error. |

`--destroy` never touches a database it does not manage (one you supplied via
`database.url`).

### `status`

Prints container health and the outputs block. Exit code `0` if running, `1` if
stopped or not found.

### `apply`

Re-applies `warehousd.yml` — schemas, tables, and `v_<collection>` views —
without a restart. Runs against the host, not inside the container.

| Flag | |
|---|---|
| `--db <url>` | Database URL. Falls back to `DATABASE_URL`, then `.warehousd/outputs.json`. |

### `seed` / `regen-synth`

Generate or regenerate synthetic data for every dataset collection. Same seed,
same data.

| Flag | |
|---|---|
| `--db <url>` | Database URL. |
| `-s, --seed <n>` | PRNG seed (default `42`). |

### `index <collection>`

Re-index a file collection. `start` does this automatically for the dev
environment.

| Flag | |
|---|---|
| `--db <url>` | Database URL. |
| `--env <env>` | `dev` or `live` (default `dev`). |
| `--source <dir>` | Override the source directory. |

`--env live` requires `source_live` in the config or an explicit `--source`. The
CLI will not index one directory into both environments.

## The outputs contract

`start` prints it and writes `.warehousd/outputs.json` so a host app can read it
programmatically:

```json
{
  "apiUrl": "http://localhost:8722",
  "mcpUrl": "http://localhost:8722/mcp",
  "adminUrl": "http://localhost:8722/admin",
  "databaseUrl": "postgres://warehousd:PASSWORD@localhost:PORT/warehousd",
  "env": "dev",
  "devClient": { "clientId": "...", "clientSecret": "..." }
}
```

`devClient` is an auto-created OAuth client whose policy allows `env:dev` only,
so a host app can obtain dev tokens immediately — the local development
experience and the production security model are the same machinery.

`.warehousd/` also holds `state.json` (generated passwords and secrets).
**Neither file is ever committed** — `init` adds the directory to `.gitignore`.

## Working offline

After the first image pull, `start` needs no network at all.

- The CLI runs `docker image inspect` before pulling, so a cached image is never
  re-fetched.
- All dependencies are baked into the image; the container entrypoint runs
  prebuilt binaries from the bundled `node_modules` rather than fetching them.
- Synthetic data comes from local wordlists and a seeded PRNG, not from a model.

The exceptions are the first `start` (which downloads roughly 260 MB), and a
Postgres you bring yourself, which must be reachable.

## Configuration

`warehousd.yml` is documented in full in
[configuration.md](configuration.md). Minimal version:

```yaml
project: acme
server: { port: 8722 }

taxonomies:
  department:
    label: Department
    terms:
      hr:      { label: HR }
      finance: { label: Finance }
  tags:
    label: Tags
    multiple: true
    terms:
      urgent: { label: Urgent }

collections:
  people:
    description: Employee directory
    fields:
      id:               { type: uuid, posture: allow, pk: true }
      full_name:        { type: text, posture: allow }
      department_id:    { type: uuid, posture: allow, fk: departments.id }
      department_name:  { type: text, posture: allow, view_join: { table: departments, column: name, on: department_id } }

  policies:
    type: file
    description: Policy documents
    source: ./seed/docs-dev
    source_live: ./seed/docs-live
    taxonomies: [department, tags]
    fields:
      title:       { posture: allow }
      content:     { posture: allow }
      path:        { posture: deny }
      review_date: { type: date, posture: allow }

synthetic:
  documents_per_collection: { people: 40 }
```

## Troubleshooting

**`DockerError: Docker is installed but the daemon isn't reachable.`**
Start Docker Desktop or the Docker daemon and retry.

**`port is already allocated`**
Change `server.port` in `warehousd.yml`, or stop whatever holds it:
`docker stop wh_<project>_server && docker rm wh_<project>_server`.

**The server starts but never becomes healthy.**
`docker logs wh_<project>_server --tail 100`. Usually one of: Postgres not ready
yet (wait and look again), a SQL error applying the schema, or a missing or
too-short `BETTER_AUTH_SECRET`.

**`outputs.json not found`**
`warehousd status` reprints the URLs.

## Example

```bash
mkdir acme-data && cd acme-data
npx warehousd init
npx warehousd start
curl http://localhost:8722/api/health   # {"ok":true}
npx warehousd stop
```

Then connect an assistant — see [connect-claude.md](connect-claude.md).
