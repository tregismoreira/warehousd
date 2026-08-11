# CLI reference

`warehousd` manages the lifecycle of a **warehousd** project: scaffolding the config, running the server and its database, applying configuration, seeding synthetic data, and indexing files.

You do not clone this repository to use it. Add a `warehousd.yml` to your own app's repo and run the CLI there.

```bash
npx warehousd <command>
# or
npm install -g warehousd
```

Requires Docker and Node 22+.

The published version is **0.1.0-rc.1**, a release candidate that is not meant to be used in production — see [the status note](status.md#release-status). It is the first release, so it holds npm's `latest` tag and a bare `npx warehousd` resolves to it; `npx warehousd@0.1.0-rc.1` pins it explicitly.

## Global flags

Available on every command.

| Flag          |                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--json`      | Machine-readable output on stdout. Secrets are **not** masked — a caller that asked for JSON asked for them.                |
| `-q, --quiet` | Suppress progress and confirmations. Errors always print, and `--json` always prints.                                       |
| `--no-color`  | Disable colour. `NO_COLOR` and `TERM=dumb` are honoured too, and colour is off automatically when output is not a terminal. |
| `--verbose`   | Echo every Docker, flyctl and railway command, and its stderr.                                                              |

These work on **every** command, `deploy` included. Progress goes to **stderr**; results and `--json` go to **stdout**. So `warehousd start 2>/dev/null` prints the summary alone, `warehousd status --json | jq` works, and a failed `warehousd deploy --json` writes its checklist to stderr while leaving stdout empty rather than unparseable.

Two deliberate exceptions:

- `--json` with `logs --follow` is an error, not a no-op — a stream has no end to serialise.
- `--verbose` never prints a failing `fly secrets` or `railway variables --set` payload. Both CLIs echo the offending assignment on that path, so it stays redacted — and `railway variables --set` carries the value in argv, so its trace prints `NAME=***` rather than the value. A debug flag that prints secrets is a secret-printing flag.

## Commands

Every command takes `-d, --dir <dir>` to point at the project directory (default: the current one).

### `init`

Scaffolds `warehousd.yml` and adds `warehousd.local.yml` and `.warehousd/` to `.gitignore`, creating that file if it does not exist. It does not create seed directories or `.warehousd/` — `start` does that.

The first question is how you want to set up at all:

- **Guided** — warehousd creates and connects everything. It asks for the container engine, which database to run **for local development** (its own container, or a provider's local stack), which deploy target to scaffold a `deploy:` block for, and which database to use **in production**: the target's own, one warehousd creates on Supabase or Neon, or one you already run. Then it checks each CLI those answers need is installed, and offers to install any that is missing.
- **Manual** — the escape hatch, and it stays first-class. It prompts for connection strings, touches no package manager, and creates nothing remote.

Every list is read from the runtime, target and host registries, so none of them goes stale. Piped, in CI, under `--json` or `--no-input` it writes the template without asking.

The install offer is always an explicit confirmation — running a package manager against your machine is not a side effect of picking a menu item — and never happens under `--no-input` unless `--install-missing` said yes in advance. From there warehousd looks for the package managers this platform actually has (`brew` and `npm` on macOS; `apt-get`, `dnf`, `pacman` or `npm` on Linux) and never invokes `sudo`: an installer that needs root is printed for you to run. Authentication is never automated either — `supabase login` and `neon auth` open a browser, and the check reports the command rather than running it.

The two database questions are independent. A container locally and Supabase in production is the ordinary case, and it is what one shared answer could not express: `--db-provider` decides `deploy.database` only and never rewrites the top-level `database:` block, while `--local-db` decides only that block.

Every wizard answer has a flag, so one command can do the lot:

```bash
warehousd init --no-input --runtime docker --local-db supabase \
  --target fly --db-provider neon --db-region aws-sa-east-1 --install-missing
```

Without `--target` or a `--db-provider` that creates a database, no `deploy:` block is written and the template's commented one is left in place — the block is optional and only `warehousd deploy` reads it.

| Flag                 |                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `--force`            | Overwrite an existing `warehousd.yml`.                                                              |
| `--no-input`         | Never prompt; write the template.                                                                    |
| `--manual`           | Skip guided setup and paste connection details yourself.                                            |
| `--runtime <id>`     | Container engine: `docker`, `podman`.                                                                |
| `--local-db <id>`    | Database for local development: `docker`, `url`, or `supabase`.                                     |
| `--target <id>`      | Scaffold a `deploy:` block for `fly`, `railway` or `compose`.                                        |
| `--db-provider <id>` | Create the production database on `supabase` or `neon` — or, with `--attach-db`, who hosts your url. |
| `--db-region <code>` | Where to create it. The database's region, not the target's.                                        |
| `--db-org <id>`      | Which organisation to create it in (Supabase, when you have more than one).                         |
| `--attach-db`        | Attach a Postgres you already run instead of creating one.                                          |
| `--install-missing`  | Install any missing provider CLI without asking.                                                    |

`--db-provider supabase` means "create one there". `--db-provider supabase --attach-db` means "the url I am about to supply is hosted there", which is what the flag meant on its own before warehousd could create anything — the two readings are worth keeping apart, so the second is spelled out rather than inferred. `--attach-db` with a provider still needs `--target`, because a provider that names where an attached url lives has no block to sit in without one.

The scaffolded `app_name` is the project name as a DNS label (`Acme Data` becomes `acme-data`) and `region` is one the target actually has, so the file it writes passes that target's own pre-flight rather than failing it on first deploy.

### `start`

Starts the server container, plus a managed Postgres container unless `database.url` is set. Applies the config, seeds synthetic data, indexes file collections, prints the outputs block, and writes `.warehousd/outputs.json`. Idempotent — re-running picks up YAML changes.

| Flag             |                                              |
| ---------------- | -------------------------------------------- |
| `-s, --seed <n>` | Synthetic data PRNG seed (default `42`).     |
| `--show-secrets` | Print credentials in full instead of masked. |

Before creating anything it checks that the ports are free and reports which image it will run and which of the three sources named it: `server.image` in `warehousd.yml`, then `WAREHOUSD_IMAGE`, then `ghcr.io/tregismoreira/warehousd:<cli-version>`.

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

Credentials are masked because this panel prints on every start and ends up in scrollback, screen shares and terminal recordings. The full values are in `.warehousd/state.json` and `outputs.json` (both mode 0600), and are printed in full by `warehousd secrets --show`, by `--show-secrets`, and by `--json`.

### `stop`

Stops the containers, keeping volumes.

| Flag        |                                                              |
| ----------- | ------------------------------------------------------------ |
| `--destroy` | Also remove the Postgres container and volume. Irreversible. |
| `-y, --yes` | Skip the confirmation.                                       |

In a terminal `--destroy` asks before removing the volume. Piped or in CI there is nobody to ask, so `--yes` is required there and its absence is an error naming the flag rather than a prompt that would hang.

`--destroy` never touches a database it does not manage (one you supplied via `database.url`).

### `status`

Prints container health and the outputs block. Exit code `0` if running, `1` if stopped or not found.

The health check uses `apiUrl` from `.warehousd/outputs.json` when that file is there, and falls back to `server.port` from `warehousd.yml` when it is not — a missing local file is not evidence that the server is down.

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

`--service db` is an error when the project brings its own Postgres via `database.url`, because there is no database container in that case.

### `open [target]`

Opens `admin` (default), `mcp` or `api` in a browser. Where no opener is known for the platform, prints the URL instead.

### `doctor`

Checks Docker, the config, the server image, both ports and the containers, then exits `0` if every check passed and `1` otherwise. Run it when `start` fails and you want to know which part is at fault.

```
  ✓  docker       daemon reachable, server 29.6.2
  ✓  config       warehousd.yml parses, 20 collection(s)
  ✓  image        warehousd:dev (WAREHOUSD_IMAGE, present locally)
  ✗  port:server  8722 is held by container other_server — stop it, or change the port in warehousd.yml
  ✓  containers   2 container(s), server running
```

| Flag       |                                                              |
| ---------- | ------------------------------------------------------------ |
| `--deploy` | Also run the deploy pre-flight — see below. Off by default.   |

`--deploy` appends the checks `warehousd deploy` runs before it builds anything: the target's own (`flyctl-ready`, `railway-region`, `compose-renders-only` …) and the `db-*` capability probe against `deploy.database.url`. Nothing mutates — every one of them is a read.

It is opt-in because the rest of `doctor` is a question about this machine, answered from local state, while these dial the production database and the target's CLI. Without the flag they are unreachable outside a deploy, which meant the only way to find out whether a hosted Postgres would work was to start one.

The inputs are the ones `deploy` uses, so what you see is what a deploy would say — including `sso-or-local-login` refusing a project with no identity provider configured and no `--allow-local-login`. That is an accurate report of a deploy that would be refused, not a broken local stack.

```
warehousd doctor --deploy
```

### `secrets`

The generated credentials, masked unless asked otherwise.

| Flag     |                                    |
| -------- | ---------------------------------- |
| `--show` | Print them in full.                |
| `--json` | Full values as JSON, for a script. |

### `apply`

Re-applies `warehousd.yml` — schemas, tables, and `v_<collection>` views — without a restart. Runs against the host, not inside the container.

Applies the project's pending migrations first, then the config. `apply` is additive: it creates tables and adds columns, and it will not rewrite a column underneath live rows. A change that would — a field's type, a removed field, a moved primary key — is refused, and `warehousd migrate` is how you get past it. See [migrations.md](migrations.md).

| Flag         |                                                                             |
| ------------ | --------------------------------------------------------------------------- |
| `--db <url>` | Database URL. Falls back to `DATABASE_URL`, then `.warehousd/outputs.json`. |

### `migrate plan`

What a config change would do to data that already exists. Reads the live schema when a database is reachable — that is the only source that can see drift no config change explains — and falls back to the config recorded by the last deploy when it is not.

Each pending change is either `ready` (the cast cannot lose anything) or `needs review` (it can).

| Flag         |               |
| ------------ | ------------- |
| `--db <url>` | Database URL. |

### `migrate generate`

Writes the pending changes to `migrations/NNNN-<name>.sql` as SQL you can read and edit. Lossless statements are written ready to run; lossy ones are commented out under a `-- REVIEW:` header that says what would be lost and lists the alternatives.

| Flag              |                                                 |
| ----------------- | ----------------------------------------------- |
| `--db <url>`      | Database URL.                                   |
| `-n, --name <s>`  | Name for the file (default `schema-change`).    |

### `migrate status`

Which of the project's migrations have been applied to a database, and which files have been edited since they were.

| Flag         |               |
| ------------ | ------------- |
| `--db <url>` | Database URL. |

All three read `.csv`, `.json` and `.xlsx`, chosen by the file's extension rather than a flag. Reading an `.xlsx` makes five choices that a spreadsheet library would make silently, and each one is a way data gets quietly corrupted — so they are stated here and in `warehousd import --help`:

- **Formula cells import their cached value**, the number Excel last calculated and saved. Nothing is evaluated, and a workbook saved without cached values imports those cells as empty — which is visible, unlike importing the formula text.
- **Dates come from Excel's serial numbers**, not from the displayed text, so a `date` column never arrives as `45231` or as an ambiguous `03/04`.
- **Merged cells** carry their value in the top-left cell only; the rest of the range is genuinely empty, as Excel stores it.
- **Text columns keep leading zeros** — `007` imports as `"007"`, never as `7`. Employee numbers and cost codes are the common case and the classic corruption.
- **A multi-sheet workbook needs `--sheet`.** Nothing is guessed; the refusal names the sheets available.

### `import map <file>`

Reads a spreadsheet's headers plus a sample of its values and **prints** a proposal — a `collections:` block if the collection does not exist yet, or an `import.columns` mapping if it does. It never writes `warehousd.yml`: you paste it, correct the inferred types and postures by hand, and `warehousd apply`.

| Flag                    |                                                       |
| ----------------------- | ----------------------------------------------------- |
| `--collection <name>`   | Propose a mapping onto an existing collection.        |
| `--sheet <name>`        | XLSX only. Required for a multi-sheet workbook.       |
| `--header-row <n>`      | 1-based. Default 1.                                   |

Inference is **deny-by-default on anything that looks sensitive**: a header containing `ssn`, `salary`, `comp`, `bank`, `iban`, `dob`, `birth`, `address`, `phone` or `passport` comes back `posture: deny`, and `email` comes back masked to its domain. It prints what it closed and why, and says plainly that it is a starting point to review.

`warehousd init --from <dir>` walks a directory and runs the same inference over every spreadsheet in it, writing one scaffold that covers all of them.

### `import validate <collection> <file>`

Checks a file against a collection **without importing it**, and reports the failures grouped by column with counts rather than as a list of row numbers — fifty row numbers out of ten thousand is not a diagnosis.

It has two layers and always says which one it ran:

| Layer                | Catches                                                                                                                                     | Blind to                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Static (no database) | Unknown, missing and derived columns; ragged rows; per-cell type coercion; YAML taxonomy terms; duplicate primary keys within the file        | Dataset-sourced taxonomy terms, reported as `unvalidatable_term`  |
| Live (`--live`)      | Everything above **plus** dataset-sourced terms, the upsert-vs-create required-column recheck, primary-key conflicts against stored documents, and whether the import role can actually write | —                                                                 |

`unvalidatable_term` is not a failure of your file: those slugs live in env-scoped `app.terms`, which the offline pass cannot read. The report names the layer and points at `--live`.

| Flag             |                                                  |
| ---------------- | ------------------------------------------------ |
| `--live`         | Run the full dry run against the database.       |
| `--mode <mode>`  | `append` (default), `upsert`, `delete`.          |
| `--sheet <name>` | XLSX only. Required for a multi-sheet workbook.  |
| `--header-row <n>` | 1-based. Default 1.                            |
| `--db <url>`     | Database URL (with `--live`).                    |

### `import run <collection> <file>`

Imports the file. `--dry-run` executes the whole thing against the real table and rolls it back, so what it reports is what would happen rather than a second guess at it. All three modes append revisions; nothing in `data_live` is rewritten or destroyed.

| Flag                                |                                            |
| ----------------------------------- | ------------------------------------------ |
| `--mode append\|upsert\|delete`     | Default `append`.                          |
| `--dry-run`                         | Execute and roll back.                     |
| `--sheet <name>` / `--header-row <n>` | XLSX only.                               |
| `--db <url>`                        | Database URL.                              |

### `seed`

Regenerate synthetic data for every dataset collection, then re-index the file collections. Same seed, same data.

The re-index is part of the command rather than a follow-up because seeding truncates the dataset collections and rebuilds the dev term set from the rows it has just generated — the term set every file row's taxonomy links point at. `--no-reindex` skips it, which is for iterating on a dataset generator in a project whose file collections are not involved.

| Flag             |                                         |
| ---------------- | --------------------------------------- |
| `--db <url>`     | Database URL.                           |
| `-s, --seed <n>` | PRNG seed (default `42`).               |
| `--no-reindex`   | Leave the file collections as they are. |

### `index <collection>`

Re-index a file collection. `start` does this automatically for the dev environment. `.md`, `.txt`, `.pdf` and `.docx` are all picked up; a binary's owner, terms and typed metadata come from a sidecar `<file>.yml` beside it.

| Flag             |                                              |
| ---------------- | -------------------------------------------- |
| `--db <url>`     | Database URL.                                |
| `--env <env>`    | `dev` or `live` (default `dev`).             |
| `--source <dir>` | Override the source directory.               |
| `--no-embed`     | Skip embedding new chunks (see `embed`).     |

`--env live` requires `source_live` in the config or an explicit `--source`. The CLI will not index one directory into both environments.

Indexing **mirrors** the directory: a file that is no longer there is removed from the collection. Documents uploaded through **Admin → Documents** were never in that directory and are left alone — see [docs/configuration.md](configuration.md), "Uploading documents from the console".

### `embed [collection]`

Fill the embedding column for file collections, so `search_documents` can answer `mode: semantic` and `mode: hybrid`. Every file collection unless one is named.

| Flag          |                                  |
| ------------- | -------------------------------- |
| `--db <url>`  | Database URL.                    |
| `--env <env>` | `dev` or `live` (default `dev`). |

Requires an `embedding:` block in `warehousd.yml`; without one the command says so rather than doing nothing. It only ever touches chunks that have no embedding, so it is safe to re-run and cheap to resume after an interruption — which matters when a remote provider rate-limits halfway through a corpus.

### `deploy`

Provisions a warehousd stack from the same `warehousd.yml` to whichever `deploy.target` names. Three exist, and they differ enough to have a runbook each:

| `deploy.target` | Where the container runs                    | Runbook                                |
| --------------- | ------------------------------------------- | -------------------------------------- |
| `fly`           | A Fly.io app                                | [deploy-fly.md](deploy-fly.md)         |
| `railway`       | A Railway project                           | [deploy-railway.md](deploy-railway.md) |
| `compose`       | A rendered Compose stack you start yourself | [deploy-compose.md](deploy-compose.md) |

Each takes either `database.managed: true`, and provisions Postgres itself, or a `database.url` you bring. Pointing one at a hosted Postgres — Supabase, Neon, Railway — is [deploy-database.md](deploy-database.md).

A pre-flight checklist must pass before anything is created: the `deploy:` block exists, all `${env:VAR}` references resolve, demo mode is off, the audit trail is on or `--allow-disabled-audit` is passed, SSO or `--allow-local-login` is configured, and the target's own checks pass — for Fly, that `flyctl` is installed and authenticated and that `region` is one of its three-letter slugs; for Railway, the same of the `railway` CLI plus which project this directory is linked to; for Compose, only what it is about to write. Every check is printed if any fail — nothing is created until all pass.

The server image is not yet published (the repo is private and no release tag exists). Until it is, build the base locally and pass `--local-build`:

```bash
docker build -f apps/web/Dockerfile -t warehousd:local .
# then in warehousd.yml:  deploy: { image: warehousd:local, ... }
warehousd deploy --local-build
```

Once a release exists and the GHCR package is public, drop the `image:` override and the flag; nothing else changes. `--local-build` needs a local Docker daemon while the default `--remote-only` path does not.

| Flag                  |                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `-d, --dir <dir>`     | Project directory (default: current).                                                              |
| `--allow-local-login` | Enable an admin account with a generated password (`admin@<host>`, e.g. `admin@myapp.fly.dev`; `admin@<app_name>.local` on Compose), in addition to any configured SSO. |
| `--allow-disabled-audit` | Deploy a project configured with `audit.enabled: false`. Nothing it does will be recorded.      |
| `-y, --yes`           | Skip the re-deploy diff prompt (one-time deploys always prompt).                                   |
| `--local-build`       | Fly only. Build the image locally; otherwise use Fly's remote builder. Railway always builds remotely and Compose builds nothing. |
| `--destroy`           | Tear down what the target created. Requires typing the app name exactly; `--yes` does not bypass. |
| `--show-secrets`      | Print the admin password and database URL in full instead of masked.                               |

A failed pre-flight is rendered by the same checklist as `doctor`, so it honours `--no-color` and `NO_COLOR` and falls back to ASCII marks off a terminal.

Re-deploys print a diff of posture changes (field access changes called out separately from other config changes) and prompt unless `--yes` is passed.

```
Posture changes:
─ people.email: allow → deny (read)
+ people.phone: (new, allow read)

Other changes:
~ people: description updated
...

Deploy y/n (without --yes)?
```

Every target runs the same steps in the same order: create the app or project, provision or attach Postgres, ship the secrets, write the project bundle, push it. What happens inside a step is the target's own — Fly sets secrets on `flyctl secrets import --stage`'s **stdin** (never argv, never written to disk) and runs the container bootstrap as a `release_command`, so a failed migration aborts the deploy and the previous release stays serving; Compose writes a `.warehousd/deploy.env` at mode 0600 and starts nothing at all. Each builds a thin `FROM <published-image>` layer containing only the project bundle, and that bundle deliberately excludes `source_live` directories and `warehousd.local.yml` — live documents never leave the operator's machine.

Then it polls `/api/health` and writes `.warehousd/outputs.deploy.json`. A target that renders files rather than running them has no URL to poll yet, so the health check is skipped and the summary prints what is left to start.

`--destroy` requires typing the app name exactly (e.g. `harbor-warehousd`), with no `--yes` bypass, to prevent accidental teardown.

## The outputs contract

`start` prints and writes `.warehousd/outputs.json` (mode 0600 — it carries the database password):

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

`devClient` is an auto-created OAuth client whose policy allows `env:dev` only, so a host app can obtain dev tokens immediately — the local development experience and the production security model are the same machinery.

`deploy` prints the deployed stack info and writes `.warehousd/outputs.deploy.json` (mode 0600, like the file above and for the same reason — these are production URLs):

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

When the target manages Postgres, `databaseUrl` is `null` — connect through the target instead (`fly postgres connect`, `railway connect Postgres`, `docker compose exec`), which is what the deploy summary prints in its place. Writing a production Postgres URL into a file in the repo is exactly the credential-at-rest the pre-flight exists to prevent. It is echoed back only when the operator supplied `deploy.database.url` themselves.

There is no `devClient` in a deploy — that is a local `start` affordance only. `env` is `"dev"` because deploys seed `data_synth` only.

`deploy --json` prints that object on stdout with five things the file does not carry: `adminEmail` and `adminPassword` (a caller that asked for JSON asked for the credential), `target` and `label` for where it went, `databaseHint` for reaching a database no URL was printed for, and `notes` — whatever the target still needs the operator to do. `notes` matters most where the file says least: a Compose deploy renders a stack and starts nothing, and the line saying so has to reach a CI caller too, not only the summary panel.

`.warehousd/` also holds `state.json` (generated passwords and secrets). **Neither file is ever committed** — `init` adds the directory to `.gitignore`.

## Working offline

After the first image pull, `start` needs no network at all.

- The CLI runs `docker image inspect` before pulling, so a cached image is never re-fetched.
- All dependencies are baked into the image; the container entrypoint runs prebuilt binaries from the bundled `node_modules` rather than fetching them.
- Synthetic data comes from local wordlists and a seeded PRNG, not from a model.

The exceptions are the first `start` (which downloads roughly 260 MB), and a Postgres you bring yourself, which must be reachable.

## Configuration

`warehousd.yml` is documented in full in [configuration.md](configuration.md). Minimal version:

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

**Docker is installed but the daemon isn't reachable.** Start Docker Desktop (or `colima start`) and retry.

**`That port is already in use.`** Change `server.port` in `warehousd.yml`, or stop whatever holds it. `doctor` names the container when a container is the holder.

**`Could not pull the server image.`** The image is resolved from `server.image`, then `WAREHOUSD_IMAGE`, then the GHCR default for your CLI version — and `doctor` prints which one won. If you built the image yourself, point at it:

```bash
docker build -f apps/web/Dockerfile -t warehousd:dev .
WAREHOUSD_IMAGE=warehousd:dev warehousd start
```

**The server starts but never becomes healthy.** `warehousd logs --tail 100`. Usually one of: Postgres not ready yet (wait and look again), a SQL error applying the schema, or a missing or too-short `BETTER_AUTH_SECRET`.

**`outputs.json not found`** `warehousd status` reprints the URLs; `warehousd secrets` reprints the credentials.

**Docker errors appearing during a normal `start`.** They should not. Every "not found" a healthy first run produces internally is captured, not printed — if you see raw daemon output, something genuinely failed. `--verbose` shows every Docker command and its stderr.

## Example

```bash
mkdir acme-data && cd acme-data
npx warehousd init
npx warehousd start
curl http://localhost:8722/api/health   # {"ok":true}
npx warehousd stop
```

Then connect an assistant — see [connect-claude.md](connect-claude.md).
