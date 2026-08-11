# warehousd

An MCP-ready governed data layer for enterprises. All your documents and datasets in one place, safely queryable by AI assistants.

This package is the `warehousd` CLI: it runs the local stack, applies configuration, seeds synthetic data, imports real data, and deploys. The server it starts is a container image published from the same release.

> **0.1.0-rc.1 is a release candidate, and is not meant to be used in production.** The code is feature-complete and covered by its own suite, but it has had no external security audit and no production deployment behind it. It is pre-1.0: interfaces can change between release candidates, and no upgrade path is guaranteed. Point it at synthetic or non-critical data and treat it as something to evaluate, not something to depend on — use at your own risk. Bug reports welcome; vulnerabilities privately, per [SECURITY.md](https://github.com/tregismoreira/warehousd/blob/main/SECURITY.md).

## Install

Requires Docker and Node 22+.

```bash
npx warehousd init      # scaffolds warehousd.yml + .gitignore entries
npx warehousd start     # starts Postgres + server, applies config, seeds synthetic data
```

Or install it globally:

```bash
npm install -g warehousd
```

`start` prints the outputs contract and writes it to `.warehousd/outputs.json` — MCP and admin URLs, the database URL, a dev client id and secret, and the generated admin login, masked until `warehousd secrets --show`.

## Commands

| Command | Purpose |
| --- | --- |
| `init` | Scaffold `warehousd.yml` and `.gitignore` entries. `--from <dir>` infers a scaffold from spreadsheets. |
| `start` · `restart` · `stop` · `status` | Run the local stack and print the outputs contract. |
| `doctor` · `logs` · `open` · `secrets` | Pre-flight, container logs, browser, generated credentials. |
| `apply` | Re-apply YAML (collections, postures, views) without a restart. |
| `migrate plan\|generate\|status` | Reviewed DDL for changes `apply` will not make — type changes, renames, drops. |
| `import map\|validate\|run` | Real-data CSV/JSON/XLSX import, with a mapping proposal and a dry run. |
| `seed` · `index <collection>` · `embed [collection]` | Regenerate synthetic data, re-index files, fill embeddings. |
| `deploy` | Ship to Fly.io, Railway or a Compose file behind a production pre-flight. |

Every command takes `--json`, `-q/--quiet`, `--no-color` and `--verbose`. Progress goes to stderr and results to stdout, so `warehousd status --json | jq` works.

## Documentation

- [Project README](https://github.com/tregismoreira/warehousd#readme) — what warehousd is and the security model
- [CLI reference](https://github.com/tregismoreira/warehousd/blob/main/docs/cli.md) — every command, flag and the outputs contract
- [Configuration reference](https://github.com/tregismoreira/warehousd/blob/main/docs/configuration.md) — every key in `warehousd.yml`
- [Connecting Claude](https://github.com/tregismoreira/warehousd/blob/main/docs/connect-claude.md) — adding the MCP connector end to end
- [Architecture](https://github.com/tregismoreira/warehousd/blob/main/docs/architecture.md) — the invariants and how each is enforced
- [Component status](https://github.com/tregismoreira/warehousd/blob/main/docs/status.md) — a per-component verdict checked against the code

## License

[Apache 2.0](https://github.com/tregismoreira/warehousd/blob/main/LICENSE).
