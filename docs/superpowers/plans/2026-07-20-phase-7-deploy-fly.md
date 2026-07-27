# Phase 7 — `warehousd deploy` (Fly.io) (Execution Outline)

> **Status: outline.** Expand with superpowers:writing-plans before executing. Spec: `docs/SPECS.md` §11 Deploy. Roadmap: Phase 7. §10 test 13.

**Goal:** One-command cloud deploy to Fly.io from the same `warehousd.yml`, gated by a production pre-flight checklist.

**Depends on:** Phase 6 (published image), Phase 4 (SSO checklist item).

## Tasks

- [ ] `deploy:` block in the config Zod schema (`target: fly`, `app_name`, `region`, `database.managed|url`)
- [ ] `warehousd deploy` shelling out to `flyctl`: detect installed + authenticated; error with install instructions otherwise
- [ ] **Pre-flight checklist — refuse unless all pass:** SSO configured *or* `--allow-local-login`; `WAREHOUSD_DISABLE_DEMO=true` (no demo personas, no seeded `data_live`); all `${env:...}` references resolve
- [ ] Create/update Fly app from the published image; Fly Postgres (`database.managed: true`) or attach `database.url`; secrets via `fly secrets set` — never written to disk
- [ ] Post-deploy: `apply` + synthetic seed against the deployed instance — **`data_synth` only; deploy never writes `data_live`** (real data arrives via the Phase 5 admin import path)
- [ ] `.warehousd/outputs.deploy.json` with public HTTPS URLs (`mcpUrl` = paste into Claude connector)
- [ ] Idempotent re-deploy: config diff printed before applying; `--yes` skips the prompt
- [ ] `deploy --destroy`: typed app-name confirmation (may hold real data)
- [ ] Runbook (`docs/deploy-fly.md`) for manual §10 test 13

**Key files:** `mvp/packages/cli/src/deploy.ts`, `mvp/packages/broker/src/config/schema.ts` (deploy block), `docs/deploy-fly.md`.

## Acceptance gate

- Automated: every checklist refusal path (demo mode on → refuse; unresolved `${env:...}` → refuse; no SSO and no flag → refuse); diff rendering unit-tested; destroy-confirmation logic tested.
- **§10 test 13 (manual runbook):** from `examples/meridian` — deploy refuses first with demo mode on; then succeeds; deployed `mcpUrl` connects from Claude over HTTPS; `data_live` empty on the deployed instance; re-deploy after a posture change applies the diff; `--destroy` teardown.
- All prior tests green.

## Expansion notes

- `flyctl` interactions should sit behind a thin exec wrapper so refusal-path and diff tests run without Fly credentials (mock the wrapper; only the runbook touches real Fly).
- Decide how `apply`/seed reach the deployed instance (one-off `fly ssh console` command vs an admin API endpoint) at expansion — affects the image entrypoint from Phase 6.
