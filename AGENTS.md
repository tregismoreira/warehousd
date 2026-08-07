# warehousd — agent instructions

For any coding agent working in this repo, whatever the assistant or editor. Humans are welcome to read it too; nothing here is addressed to one tool. It covers what the other docs do not say: how code in this repo is written, where tests go, and how to share a machine with other checkouts.

## Start here

- [CONTRIBUTING.md](CONTRIBUTING.md) — install, environment variables, bootstrap, PR checklist.
- [docs/architecture.md](docs/architecture.md) — the security invariants. Authoritative; this file summarises, it does not replace.
- [docs/glossary.md](docs/glossary.md) — **collection, document, field.** Not table, row, item. This is product vocabulary, not a preference; use it in code, tests, and prose.
- [docs/testing.md](docs/testing.md) — the suites in full, including the slow ones.

## Commands

```bash
pnpm install
pnpm test:up                                       # Postgres + Keycloak, required before tests
WAREHOUSD_PROJECT_DIR=examples/harbor pnpm test    # parallel pass, then serial pass
pnpm lint
pnpm typecheck                                     # src + test + e2e + scripts
pnpm format:check                                  # Prettier, code only
pnpm build                                         # production build
pnpm e2e                                           # Playwright, real browser
```

All six of `lint`, `typecheck`, `format:check`, `test`, `build`, `e2e` must be clean before a PR — CI runs every one of them. **`pnpm test` does not typecheck** — vitest transpiles without checking, so `pnpm typecheck` is what catches a type error and a green test run proves less than it looks like.

**Do not run the full suite to check your own work** — CI is the gate. Run `pnpm test <filter>` for what you changed, plus `typecheck` and `lint`; a bare `test`, `build` or `e2e` only when asked or when no filter covers the change.

`pnpm test:down` takes the volume with it and forces the next run to rebuild the cached template databases from scratch. Use `docker compose -f docker-compose.test.yml stop` unless you actually want that.

## Non-negotiables

Each of these is enforced somewhere. Breaking one is a release blocker, not a cleanup task.

1. **The broker is the trust boundary.** `packages/broker` stays free of HTTP, MCP, UI, and LLM imports — `no-restricted-imports` in `eslint.config.js`. No code outside the broker reads collection tables.
2. **Client input reaches SQL only as a bound parameter.** Values go through `param()`, identifiers through `q()`, both in `packages/broker/src/sql/build.ts`. Identifiers come from validated config, never from a request.
3. **Every decision passes through exactly one audit call before returning** — refusals included — via `makeAuditWriter` (`packages/broker/src/audit/decision.ts`), and the configured sink decides whether that call lands in a row. With the trail on (the default) an allow whose audit write fails is caught and downgraded to a refusal. With `audit.enabled: false` nothing is written and `auditId` is null throughout. Do not "fix" either null by fabricating an id, and do not collapse the two: a null with auditing on is a failure, a null with it off is the configured answer.
4. **Denied means absent.** A denied field must not appear in a response, an error message, or a log line. When in doubt add a canary to the fixtures and grep for it.
5. **Touching enforcement means shipping a test that fails without your change.** Postures, grants, env isolation, SQL construction, audit.

## Code conventions

Code is formatted by **Prettier** (`.prettierrc.json`), and `pnpm format:check` is a CI gate. Run `pnpm format` before you open a PR rather than hand-aligning anything. Prose is deliberately out of scope — `.prettierignore` excludes `*.md`, fixtures and seed content.

**Markdown prose is not hard-wrapped.** One paragraph is one line; let the editor soft-wrap it. A hard-wrapped paragraph makes every later edit reflow lines nobody touched, which buries the real change in a diff. Structure still breaks the line as usual — headings, list items, table rows, fenced code. `scripts/agent/unwrap-md.py <file>` joins a wrapped file back up and refuses if that would change a word. Seed and fixture markdown under `examples/harbor/seed/` and `apps/web/e2e/fixtures/` is exempt: tests assert on its text.

- Filenames kebab-case (`migrate-app.ts`, `env-scope.ts`). Named exports, no default exports.
- Functions and plain types. No domain classes — `interface`/`type` for shapes, a module per concern (`grants/eval.ts`, `sql/build.ts`).
- **Outcomes are discriminated unions, not exceptions**: `{ ok: true, … } | { ok: false, reason: RefusalReason, auditId }`. A caller should have to handle refusal to compile. Throw only for a mistake in our own code, and give it a type (`UnsupportedFilter` in `sql/build.ts`).
- On a driver or unexpected error: log `console.error("[broker] … failed", { collection, err })` and return `internal_error`. **Never** let SQL text, column names, or driver messages reach a caller.
- Validate external input at the boundary with zod (`packages/broker/src/config/schema.ts`) and infer the type from the schema rather than declaring it twice.
- `as const` arrays with an inferred union, not TypeScript `enum`.
- `strict` and `noUncheckedIndexedAccess` are on (`tsconfig.base.json`). Narrow properly — reaching for `any` or a `!` to quiet the compiler defeats the reason they are on.

## Tests

Tests live in a `test/` directory beside the code, not next to the source file.

| Where | Pattern | Run by |
| --- | --- | --- |
| `packages/*/test/`, `apps/web/test/` | `*.test.ts`, `*.integration.test.ts` | `pnpm test` (parallel pass) |
| `packages/broker/test/`, `apps/web/test/` | the files in `SERIAL_TESTS` (`vitest.config.ts`) | `pnpm test` (serial pass) |
| `packages/cli/test/e2e/` | `*.e2e.test.ts` | `pnpm test:e2e:cli` |
| `apps/web/e2e/` | `*.spec.ts` | `pnpm e2e` |

- `provision()` in `packages/broker/test/helpers/db.ts` clones a template into a database of that test file's own. Use it. Do not share state between files, and do not reach into another file's database.
- `pnpm test` is two vitest passes because a few suites mutate cluster-global state (`scripts/run-tests.ts`). Adding a file to `SERIAL_TESTS` costs everyone wall-clock time — do it only when the suite genuinely cannot tolerate a neighbour, and say why in the PR.
- A filter is forwarded to whichever pass can satisfy it, so `pnpm test change-feed` works.

## Machine load

More than one working copy of this repo may exist on one machine — worktrees, parallel checkouts, several agents at once. `docker-compose.test.yml` binds a **fixed** host port (`127.0.0.1:54330`), so **one Postgres serves all of them**. Consequences that have already caused bugs:

- Roles and databases are cluster-global. Every test database this checkout creates ends in a per-checkout suffix — `runDbName` and `templateName` in `packages/broker/test/helpers/templates.ts`. Keep it that way: it is the only thing that tells your leftovers from a sibling's live database.
- **Never `drop database` by a broad `wh_%` pattern** — you will destroy a sibling's running suite. Scope it to the suffix, or use `pnpm agent:cleanup`, which does.
- **Never `docker compose down -v`** — it wipes the shared volume for every checkout.
- See [docs/testing.md](docs/testing.md), "Running two checkouts at once", before running two.

So: **one heavy process at a time**, serially, waiting for each to exit. Test suites, browsers, builds, installs, database imports.

```bash
pnpm agent:guard "pnpm test"   # is a suite already running anywhere? exit 1 means yes
pnpm agent:cleanup             # kill what this checkout started; reclaim the shared server if quiet
```

Under Claude Code these run automatically — `.claude/hooks/` wires them to PreToolUse and SessionEnd — and a second suite is refused outright. Do not rename a command to slip past the guard; that check is the only coordination that exists between checkouts. Under any other harness, run them yourself.

Anything you start, you own until it is stopped: a background process, a container, a dev server. `agent:cleanup` is a backstop, not permission to be careless — it cannot run if the process supervisor dies, and it deliberately leaves shared state alone while another suite is live.

"Testing concurrency" is not an exception. Ask first.

## Scope

- One focused change per pull request; say which invariant or behaviour it affects.
- Do not reformat, refactor, or add comments to code your change does not touch. A diff that is hard to review is a diff that hides things.
- Ask before adding a dependency. `packages/broker` in particular is meant to stay thin.
- **`@clack/prompts` is pinned to `^0.11` on purpose.** 1.x is ESM-only — no `require` condition — and `packages/cli` builds to a CommonJS bundle (`tsup.config.ts`, bin `dist/index.cjs`). A caret on a `0.x` will not drift there by itself, but do not widen the range or bump it by hand without moving the CLI build to ESM first. `pnpm --filter ./packages/cli build && node packages/cli/dist/index.cjs --help` is the check.
- Do not report a security vulnerability through a PR or issue — see [SECURITY.md](SECURITY.md).
