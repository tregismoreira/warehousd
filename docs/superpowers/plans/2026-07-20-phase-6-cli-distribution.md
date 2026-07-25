# Phase 6 — CLI Lifecycle + Distribution (Execution Outline)

> **Status: outline.** Expand with superpowers:writing-plans before executing. Spec: `docs/SPECS.md` §11 (minus deploy). Roadmap: Phase 6. **Parallel with Phase 5.**

**Goal:** Full Supabase-style CLI (`init/start/stop/status/apply/seed/regen-synth/index`) plus published artifacts: `ghcr.io/<org>/warehousd` Docker image and the `warehousd` npm package.

**Depends on:** Phase 2 (devClient uses client-policy machinery); a server image implies Phases 1–4 baked in.

## Tasks

- [ ] `warehousd init`: scaffold starter `warehousd.yml` (Meridian collections commented as examples) + `.gitignore` entries (`warehousd.local.yml`, `.warehousd/`)
- [ ] `warehousd start`: read config → pull/start server image + Postgres (or `database.url`) under the project namespace → run `apply` + synthetic seed (+ document index for `type: file` collections) → print outputs block → write `.warehousd/outputs.json`; idempotent — re-run picks up YAML changes
- [ ] `warehousd stop` (keep volumes) / `stop --destroy` (remove volumes); `warehousd status` (health + outputs block)
- [ ] Outputs contract exactly per §11 (`mcpUrl`, `apiUrl`, `adminUrl`, `databaseUrl`, `env`, `devClient{clientId,clientSecret}`); `devClient` auto-created with `allowed_scopes = {env:dev}` via Phase 2 machinery
- [ ] Docker integration via `dockerode` or shell-out (pick one at expansion); clear error when Docker isn't running
- [ ] `apps/web/Dockerfile` + publishing pipeline: GitHub Actions builds/pushes the image and publishes the npm CLI
- [ ] Offline guarantee: after image pull, `start` works with network disabled — documented + manually verified
- [ ] `mvp/examples/meridian` runs entirely via `npx warehousd start` (true consuming-project example)

**Key files:** `mvp/packages/cli/src/{init,start,stop,status,deploy-shared}.ts` (grow from the existing `apply`/`seed`/`index`), `mvp/apps/web/Dockerfile`, `.github/workflows/{ci,release}.yml`.

## Acceptance gate

- E2E test (local; CI-optional): from a temp dir with only `warehousd.yml` — `init/start/status/apply/stop` full cycle; `outputs.json` matches the contract; devClient token mint works against the started stack; re-run `start` after a YAML posture change applies the diff.
- Offline check documented and manually verified once.
- All prior tests green.

## Expansion notes

- CI needs a strategy for the Docker-in-Docker E2E (or mark it local-only with a make target); decide at expansion.
- `start` must run Better Auth migrations + `createAppSchema` + apply + seed in the container entrypoint idempotently — the ordering is the tricky part; write it as its own task.
- Image naming/org and npm package name must be settled before the release workflow task.
