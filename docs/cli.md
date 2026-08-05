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

## Global flags

Available on every command.

| Flag          |                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--json`      | Machine-readable output on stdout. Secrets are **not** masked — a caller that asked for JSON asked for them.                |
| `-q, --quiet` | Suppress progress and confirmations. Errors always print, and `--json` always prints.                                       |
| `--no-color`  | Disable colour. `NO_COLOR` and `TERM=dumb` are honoured too, and colour is off automatically when output is not a terminal. |
| `--verbose`   | Echo every Docker and flyctl command, and its stderr.                                                                       |

These work on **every** command, `deploy` included. Progress goes to **stderr**;
results and `--json` go to **stdout**. So `warehousd start 2>/dev/null` prints the
summary alone, `warehousd status --json | jq` works, and a failed
`warehousd deploy --json` writes its checklist to stderr while leaving stdout
empty rather than unparseable.

Two deliberate exceptions:

- `--json` with `logs --follow` is an error, not a no-op — a stream has no end to
  serialise.
- `--verbose` never prints a failing `fly secrets` payload. flyctl echoes the
  offending assignment on that path, so it stays redacted; a debug flag that
  prints secrets is a secret-printing flag.

## Commands

Every command takes `-d, --dir <dir>` to point at the project directory
(default: the current one).

### `init`

Scaffolds `warehousd.yml` and adds `warehousd.local.yml` and `.warehousd/` to
`.gitignore`, creating that file if it does not exist. It does not create seed
directories or `.warehousd/` — `start` does that.

In a terminal it asks for the project name, the port and whether to manage
Postgres, then applies those answers to the template. Piped, in CI, under
`--json` or `--no-input` it writes the default template without asking.

| Flag         |                                           |
| ------------ | ----------------------------------------- |
| `--force`    | Overwrite an existing `warehousd.yml`.    |
| `--no-input` | Never prompt; write the default template. |

### `start`

Starts the server container, plus a managed Postgres container unless
`database.url` is set. Applies the config, seeds synthetic data, indexes file
collections, prints the outputs block, and writes `.warehousd/outputs.json`.
Idempotent — re-running picks up YAML changes.

| Flag             |                                              |
| ---------------- | -------------------------------------------- |
| `-s, --seed <n>` | Synthetic data PRNG seed (default `42`).     |
| `--show-secrets` | Print credentials in full instead of masked. |

Before creating anything it checks that the ports are free and reports which
image it will run and which of the three sources named it: `server.image` in
`warehousd.yml`, then `WAREHOUSD_IMAGE`, then
`ghcr.io/tregismoreira/warehousd:<cli-version>`.

Progress is written to stderr as each step completes:

```
✓  Checking  harbor              docker 29.6.2 · 120ms
✓     Image  warehousd:dev       WAREHOUSD_IMAGE, local · 40ms
✓  Starting  wh_harbor_db → :8723                       · 0.9s
✓  Starting  wh_harbor_server → :8722                   · 0.6s
✓   Waiting  health check                               · 12.4s
```

Then the summary, on stdout:

```
  warehousd is running  ready in 15.1s

  MCP       http://localhost:8722/mcp
  API       http://localhost:8722
  Admin     http://localhost:8722/admin
  Database  postgres://warehousd:7fc2…c97d@localhost:8723/warehousd
  Env       dev

  Dev client
    ID      2f564a968b9bbaafdb7b78cddec53c63
    Secret  4215…daf8

  Admin login
    Email     admin@warehousd.local
    Password  7ac7…996b

  Secrets are masked — reveal with `warehousd secrets --show`
```

Credentials are masked because this panel prints on every start and ends up in
scrollback, screen shares and terminal recordings. The full values are in
`.warehousd/state.json` and `outputs.json` (both mode 0600), and are printed in
full by `warehousd secrets --show`, by `--show-secrets`, and by `--json`.

### `stop`

Stops the containers, keeping volumes.

| Flag        |                                                              |
| ----------- | ------------------------------------------------------------ |
| `--destroy` | Also remove the Postgres container and volume. Irreversible. |
| `-y, --yes` | Skip the confirmation.                                       |

In a terminal `--destroy` asks before removing the volume. Piped or in CI there
is nobody to ask, so `--yes` is required there and its absence is an error
naming the flag rather than a prompt that would hang.

`--destroy` never touches a database it does not manage (one you supplied via
`database.url`).

### `status`

Prints container health and the outputs block. Exit code `0` if running, `1` if
stopped or not found.

The health check uses `apiUrl` from `.warehousd/outputs.json` when that file is
there, and falls back to `server.port` from `warehousd.yml` when it is not — a
missing local file is not evidence that the server is down.

| Flag             |                                                   |
| ---------------- | ------------------------------------------------- |
| `--show-secrets` | Print the database URL in full instead of masked. |

### `restart`

`stop` then `start`, keeping data. Takes `-s, --seed <n>` and `--show-secrets`.

### `logs`

Container logs, without having to assemble the container name yourself.

| Flag               |                                |
| ------------------ | ------------------------------ |
| `-f, --follow`     | Stream until interrupted.      |
| `-n, --tail <n>`   | Lines to show (default `100`). |
| `--service <name>` | `server` (default) or `db`.    |

`--service db` is an error when the project brings its own Postgres via
`database.url`, because there is no database container in that case.

### `open [target]`

Opens `admin` (default), `mcp` or `api` in a browser. Where no opener is known
for the platform, prints the URL instead.

### `doctor`

Checks Docker, the config, the server image, both ports and the containers, then
exits `0` if every check passed and `1` otherwise. Run it when `start` fails and
you want to know which part is at fault.

```
  ✓  docker       daemon reachable, server 29.6.2
  ✓  config       warehousd.yml parses, 20 collection(s)
  ✓  image        warehousd:dev (WAREHOUSD_IMAGE, present locally)
  ✗  port:server  8722 is held by container other_server — stop it, or change the port in warehousd.yml
  ✓  containers   2 container(s), server running
```

### `secrets`

The generated credentials, masked unless asked otherwise.

| Flag     |                                    |
| -------- | ---------------------------------- |
| `--show` | Print them in full.                |
| `--json` | Full values as JSON, for a script. |

### `apply`

Re-applies `warehousd.yml` — schemas, tables, and `v_<collection>` views —
without a restart. Runs against the host, not inside the container.

Applies the project's pending migrations first, then the config. `apply` is
additive: it creates tables and adds columns, and it will not rewrite a column
underneath live rows. A change that would — a field's type, a removed field, a
moved primary key — is refused, and `warehousd migrate` is how you get past it.
See [migrations.md](migrations.md).

| Flag         |                                                                             |
| ------------ | --------------------------------------------------------------------------- |
| `--db <url>` | Database URL. Falls back to `DATABASE_URL`, then `.warehousd/outputs.json`. |

### `migrate plan`

What a config change would do to data that already exists. Reads the live schema
when a database is reachable — that is the only source that can see drift no
config change explains — and falls back to the config recorded by the last
deploy when it is not.

Each pending change is either `ready` (the cast cannot lose anything) or
`needs review` (it can).

| Flag         |               |
| ------------ | ------------- |
| `--db <url>` | Database URL. |

### `migrate generate`

Writes the pending changes to `migrations/NNNN-<name>.sql` as SQL you can read
and edit. Lossless statements are written ready to run; lossy ones are commented
out under a `-- REVIEW:` header that says what would be lost and lists the
alternatives.

| Flag              |                                                 |
| ----------------- | ----------------------------------------------- |
| `--db <url>`      | Database URL.                                   |
| `-n, --name <s>`  | Name for the file (default `schema-change`).    |

### `migrate status`

Which of the project's migrations have been applied to a database, and which
files have been edited since they were.

| Flag         |               |
| ------------ | ------------- |
| `--db <url>` | Database URL. |

### `seed`

Regenerate synthetic data for every dataset collection, then re-index the file
collections. Same seed, same data.

The re-index is part of the command rather than a follow-up because seeding
truncates the dataset collections and rebuilds the dev term set from the rows it
has just generated — the term set every file row's taxonomy links point at.
`--no-reindex` skips it, which is for iterating on a dataset generator in a
project whose file collections are not involved.

| Flag             |                                         |
| ---------------- | --------------------------------------- |
| `--db <url>`     | Database URL.                           |
| `-s, --seed <n>` | PRNG seed (default `42`).               |
| `--no-reindex`   | Leave the file collections as they are. |

### `index <collection>`

Re-index a file collection. `start` does this automatically for the dev
environment. `.md`, `.txt`, `.pdf` and `.docx` are all picked up; a binary's
owner, terms and typed metadata come from a sidecar `<file>.yml` beside it.

| Flag             |                                              |
| ---------------- | -------------------------------------------- |
| `--db <url>`     | Database URL.                                |
| `--env <env>`    | `dev` or `live` (default `dev`).             |
| `--source <dir>` | Override the source directory.               |
| `--no-embed`     | Skip embedding new chunks (see `embed`).     |

`--env live` requires `source_live` in the config or an explicit `--source`. The
CLI will not index one directory into both environments.

Indexing **mirrors** the directory: a file that is no longer there is removed
from the collection. Documents uploaded through **Admin → Documents** were never
in that directory and are left alone — see
[docs/configuration.md](configuration.md), "Uploading documents from the
console".

### `embed [collection]`

Fill the embedding column for file collections, so `search_documents` can answer
`mode: semantic` and `mode: hybrid`. Every file collection unless one is named.

| Flag          |                                  |
| ------------- | -------------------------------- |
| `--db <url>`  | Database URL.                    |
| `--env <env>` | `dev` or `live` (default `dev`). |

Requires an `embedding:` block in `warehousd.yml`; without one the command says
so rather than doing nothing. It only ever touches chunks that have no embedding,
so it is safe to re-run and cheap to resume after an interruption — which matters
when a remote provider rate-limits halfway through a corpus.

### `deploy`

Provisions a warehousd stack to Fly.io from the same `warehousd.yml`. A
pre-flight checklist must pass before anything is created: the `deploy:` block
exists, all `${env:VAR}` references resolve, demo mode is off, the audit trail is
on or `--allow-disabled-audit` is passed, SSO or `--allow-local-login` is
configured, and the target's own checks pass — for Fly, that `flyctl` is
installed and authenticated and that `region` is one of its three-letter slugs.
Every check is printed if any fail — nothing is created until all pass.

The server image is not yet published (the repo is private and no release tag
exists). Until it is, build the base locally and pass `--local-build`:

```bash
docker build -f apps/web/Dockerfile -t warehousd:local .
# then in warehousd.yml:  deploy: { image: warehousd:local, ... }
warehousd deploy --local-build
```

Once a release exists and the GHCR package is public, drop the `image:` override
and the flag; nothing else changes. `--local-build` needs a local Docker daemon
while the default `--remote-only` path does not.

| Flag                  |                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `-d, --dir <dir>`     | Project directory (default: current).                                                              |
| `--allow-local-login` | Enable `admin@warehousd.local` with a generated password, in addition to any configured SSO.       |
| `--allow-disabled-audit` | Deploy a project configured with `audit.enabled: false`. Nothing it does will be recorded.      |
| `-y, --yes`           | Skip the re-deploy diff prompt (one-time deploys always prompt).                                   |
| `--local-build`       | Build the image locally; otherwise use the published one.                                          |
| `--destroy`           | Tear down the Fly app and database. Requires typing the app name exactly; `--yes` does not bypass. |
| `--show-secrets`      | Print the admin password and database URL in full instead of masked.                               |

A failed pre-flight is rendered by the same checklist as `doctor`, so it honours
`--no-color` and `NO_COLOR` and falls back to ASCII marks off a terminal.

Re-deploys print a diff of posture changes (field access changes called out
separately from other config changes) and prompt unless `--yes` is passed.

```
Posture changes:
─ people.email: allow → deny (read)
+ people.phone: (new, allow read)

Other changes:
~ people: description updated
...

Deploy y/n (without --yes)?
```

The deployment creates a Fly app, provisions or attaches Postgres, sets secrets
via `flyctl secrets import --stage` on **stdin** (never argv, never written to
disk), builds a thin `FROM <published-image>` layer containing only the project
bundle, and runs the existing container bootstrap as Fly's `release_command`
(so a failed migration aborts the deploy and the previous release stays serving).
The bundle deliberately excludes `source_live` directories and
`warehousd.local.yml` — live documents never leave the operator's machine.

Then it polls `/api/health` and writes `.warehousd/outputs.deploy.json`.

`--destroy` requires typing the app name exactly (e.g. `harbor-warehousd`), with
no `--yes` bypass, to prevent accidental teardown.

## The outputs contract

`start` prints and writes `.warehousd/outputs.json` (mode 0644):

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

`deploy` prints the deployed stack info and writes `.warehousd/outputs.deploy.json`
(mode 0600, strictly more limited due to containing production URLs):

```json
{
  "apiUrl": "https://harbor-warehousd.fly.dev",
  "mcpUrl": "https://harbor-warehousd.fly.dev/mcp",
  "adminUrl": "https://harbor-warehousd.fly.dev/admin",
  "databaseUrl": null,
  "env": "dev",
  "devClient": null
}
```

When Fly manages Postgres, `databaseUrl` is `null` — use `fly postgres connect`
instead. Writing a production Postgres URL into a file in the repo is exactly the
credential-at-rest the pre-flight exists to prevent. It is echoed back only when
the operator supplied `deploy.database.url` themselves.

There is no `devClient` in a deploy — that is a local `start` affordance only.
`env` is `"dev"` because deploys seed `data_synth` only.

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
      hr: { label: HR }
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
      id: { type: uuid, posture: allow, pk: true }
      full_name: { type: text, posture: allow }
      department_id: { type: uuid, posture: allow, fk: departments.id }
      department_name:
        {
          type: text,
          posture: allow,
          view_join: { table: departments, column: name, on: department_id },
        }

  policies:
    type: file
    description: Policy documents
    source: ./seed/docs-dev
    source_live: ./seed/docs-live
    taxonomies: [department, tags]
    fields:
      title: { posture: allow }
      content: { posture: allow }
      path: { posture: deny }
      review_date: { type: date, posture: allow }

synthetic:
  documents_per_collection: { people: 40 }
```

## Troubleshooting

`warehousd doctor` answers most of this in one command — run it first.

**Docker is installed but the daemon isn't reachable.**
Start Docker Desktop (or `colima start`) and retry.

**`That port is already in use.`**
Change `server.port` in `warehousd.yml`, or stop whatever holds it. `doctor`
names the container when a container is the holder.

**`Could not pull the server image.`**
The image is resolved from `server.image`, then `WAREHOUSD_IMAGE`, then the GHCR
default for your CLI version — and `doctor` prints which one won. If you built
the image yourself, point at it:

```bash
docker build -f apps/web/Dockerfile -t warehousd:dev .
WAREHOUSD_IMAGE=warehousd:dev warehousd start
```

**The server starts but never becomes healthy.**
`warehousd logs --tail 100`. Usually one of: Postgres not ready yet (wait and
look again), a SQL error applying the schema, or a missing or too-short
`BETTER_AUTH_SECRET`.

**`outputs.json not found`**
`warehousd status` reprints the URLs; `warehousd secrets` reprints the
credentials.

**Docker errors appearing during a normal `start`.**
They should not. Every "not found" a healthy first run produces internally is
captured, not printed — if you see raw daemon output, something genuinely
failed. `--verbose` shows every Docker command and its stderr.

## Example

```bash
mkdir acme-data && cd acme-data
npx warehousd init
npx warehousd start
curl http://localhost:8722/api/health   # {"ok":true}
npx warehousd stop
```

Then connect an assistant — see [connect-claude.md](connect-claude.md).
