# warehousd MVP Roadmap

Phases and tasks from the Phase 0 POC to a production-ready MVP.

- Spec: [SPECS.md](./SPECS.md) — §-references below point there.
- Phase 0 plan (done first): [plans/2026-07-18-phase-0-poc.md](./superpowers/plans/2026-07-18-phase-0-poc.md)
- Phase detail + post-MVP backlog: [plans/2026-07-18-phases-mvp-and-post-mvp.md](./superpowers/plans/2026-07-18-phases-mvp-and-post-mvp.md)

> Before executing a phase, expand it into a task-by-task TDD plan with the `writing-plans` skill (as Phase 0 was) and execute via subagent-driven development. Tasks below are the checklist of deliverables, not step-level instructions.

**MVP definition of done:** all §10 acceptance tests pass (1–10 automated in CI, 11–12 as manual runbooks) and the README ships the stub-vs-real table (§10).

**Ordering:** Phases 1→4 are sequential (auth spine). Phases 5 and 6 can run in parallel after 4. Phase 7 needs 4 + 6. Phase 8 closes.

---

## Phase 0 — POC (complete before MVP work) ✅ gate: §13

Enforcement core: broker, postures, dual DB roles, synthetic data, audit, persona-switched chat console. See the [Phase 0 plan](./superpowers/plans/2026-07-18-phase-0-poc.md). Throwaway pieces marked `// POC-ONLY` (persona switcher, console identity handling) are replaced in Phases 1–3.

---

## Phase 1 — Real identity: Better Auth core + roles (§6.2–6.3)

- [ ] Install Better Auth in `apps/web`; auth tables (`user`, `session`, `account`) in the `app` schema
- [ ] Local email/password login (bootstrap fallback only) + login screen; demo mode shows §9 persona credentials
- [ ] `role` on user (`admin`/`manager`/`member`); seed Ana/Marcus/Priya as real users with §9 roles + grants
- [ ] Support `SANDBOXD_DISABLE_LOCAL_LOGIN=true` (fully disables local credentials)
- [ ] Delete the POC persona switcher; derive `BrokerContext` in UI routes from the verified session (env via authenticated console toggle)
- [ ] Role checks on grants API (approve/deny/revoke = manager/admin only)
- [ ] Tests: 401 on unauthenticated routes; 403 on member-approve; request-body userId/env provably ignored; all Phase 0 tests still green

## Phase 2 — OAuth 2.1 provider + env-as-scope (§6.1, §6.4–6.6)

- [ ] Better Auth OIDC-provider/MCP plugin: warehousd as OAuth 2.1 authorization server; 15-min access tokens + refresh tokens
- [ ] `app.client_policies` table per §6.1 (`allowed_scopes` default `{env:dev}`, `promoted_at`, `promoted_by`)
- [ ] Scope-issuance hook, §6.1 rules 1–4: client-policy intersection → user live-grant eligibility → consent-screen env picker (exactly one env scope) → rules re-run on every refresh
- [ ] Dynamic client registration (RFC 7591): dynamic clients get `{env:dev, env:live}`; manually created clients get `{env:dev}` always
- [ ] Token-verification adapter: sole constructor of `BrokerContext` for token paths; missing env scope → `dev`; tokens carry no grant data
- [ ] Promotion/demotion primitives (data layer + API; UI in Phase 5)
- [ ] Tests — completes §10 test 5: scope-escalation refused; promotion/demotion take effect on next refresh; no-live-grant user never gets `env:live`; token payload contains only sub/client/env

## Phase 3 — MCP endpoint (§7)

- [ ] `/mcp` streamable-HTTP endpoint (MCP TypeScript SDK), OAuth-protected, `BrokerContext` from token
- [ ] Tools (complete list): `list_collections`, `describe_collection`, `query_collection`, `request_access`
- [ ] Refusals include the `request_access` hint; tool descriptions state deny-by-default + purpose-bound governance plainly
- [ ] Rewire the chat console's tool loop onto the shared tool implementations (console = local MCP test bench)
- [ ] Tests: MCP-over-HTTP integration (grant-filtered describe, probe-suite refusals, zero canary leakage, pending grant from `request_access`); dev-token env wall across all tools; §10 test 6 (env parity — identical shapes dev vs live)

## Phase 4 — SSO: OIDC, JIT, IdP-delegated MCP login (§6.1–6.4)

- [ ] Better Auth SSO plugin: generic OIDC (Okta / Entra ID / Google Workspace); SAML only if free in the same plugin, else marked `stubbed`
- [ ] IdP config (issuer, client id/secret) stored in DB, admin-editable — no code change, no redeploy (API here; form in Phase 5)
- [ ] JIT provisioning: first SSO login creates a `member`
- [ ] SSO configured → login defaults to SSO; local login off when disabled
- [ ] MCP OAuth authorize step delegates to the IdP ("log in with your company account")
- [ ] Tests: JIT role = member; local-login rejection; IdP CRUD admin-only
- [ ] §10 test 11 (manual): runbooks `docs/connect-claude.md` + `docs/configure-sso.md` with screenshots — IdP → Claude connector → tools work → denied-field probe fails cleanly

## Phase 5 — Admin / Manager / Member web UI (§8) — parallel with Phase 6

Apply the `frontend-design` skill; keep the Phase 0 "security console" aesthetic.

- [ ] Admin: collections & postures view (YAML state + apply status), SSO config form, user role management, regenerate-dev-data button, audit browser (filter by user/collection/outcome)
- [ ] Admin → Clients (§6.1): list, "New client" (id+secret, `{env:dev}` always), per-client scopes + promotion audit trail + last token, promote/demote actions
- [ ] **Real-data import path** (spec-implied by §11 "real data arrives via the admin import path"): admin-only CSV/JSON upload per collection into `data_live`, validated against the YAML schema, via a dedicated write role — audited, and covered by leak probes (only write path into live data)
- [ ] Manager: grant inbox → approve (trim fields, set expiry) / deny; active grants with revoke
- [ ] Member: my grants + statuses; how-to-connect page (MCP URL + Claude connector setup)
- [ ] Navigation/layout; chat console kept as a dev-mode page
- [ ] Tests: per-surface role 403s; §10 test 7 driven through the UI/API; promotion tests through the real surface; import-path validation + audit; design review pass

## Phase 6 — CLI lifecycle + distribution (§11) — parallel with Phase 5

- [ ] Full CLI: `init`, `start`, `stop [--destroy]`, `status`, `apply`, `seed`, `regen-synth` (grows from Phase 0 subset)
- [ ] `start`: config → pull/start server image + Postgres (or `database.url`) under project namespace → apply + seed → print outputs → write `.warehousd/outputs.json`; idempotent
- [ ] Outputs contract per §11 incl. auto-created `devClient` (`allowed_scopes = {env:dev}`, Phase 2 machinery)
- [ ] Docker via `dockerode` or shell-out; clear error when Docker isn't running
- [ ] Publishing: GitHub Actions → `ghcr.io/<org>/warehousd` image + `warehousd` npm package
- [ ] Offline guarantee verified (post-pull `start` with network disabled)
- [ ] `examples/meridian` runs entirely via `npx warehousd start`
- [ ] Tests: full lifecycle E2E from a bare dir; outputs contract; devClient token mint; YAML-change re-apply

## Phase 7 — `warehousd deploy` (Fly.io) (§11 Deploy)

- [ ] `deploy` via `flyctl` shell-out (detect installed+authenticated; error with install instructions)
- [ ] Pre-flight checklist — refuse unless: SSO configured or `--allow-local-login`; `SANDBOXD_DISABLE_DEMO=true`; all `${env:...}` resolve
- [ ] Create/update Fly app from published image; Fly Postgres or `database.url`; secrets via `fly secrets set` (never on disk)
- [ ] Post-deploy apply + synthetic seed (`data_synth` only — deploy never writes `data_live`)
- [ ] `.warehousd/outputs.deploy.json` with HTTPS URLs; idempotent re-deploy with config diff (`--yes`); `--destroy` with typed app-name confirmation
- [ ] Tests: all checklist refusal paths; diff rendering
- [ ] §10 test 12 (manual): runbook — refuses with demo mode on; deployed `mcpUrl` works from Claude over HTTPS; `data_live` empty; posture-change re-deploy; teardown

## Phase 8 — Production hardening, docs, release gate (§10, §11)

Operational items beyond the spec text, required for "production ready":

- [ ] Versioned `app`-schema migrations (Drizzle Kit) so upgrades on an existing deploy preserve grants/audit (replaces create-if-not-exists-only)
- [ ] `/health` endpoint; wired to `warehousd status` and Fly health checks
- [ ] Auth abuse controls: rate limiting on login/token endpoints, lockout on local credentials (verify what Better Auth provides; fill gaps)
- [ ] Session/CSRF hardening for the deployed HTTPS origin (cookie flags, trusted origins)
- [ ] Log-redaction policy covering framework logs (Next.js/Better Auth request bodies, OAuth errors); extend probe assertions to them
- [ ] Audit retention decision documented (even if "no rotation in MVP") in the threat model
- [ ] Backup guidance (Fly Postgres snapshots) in the deploy runbook

Release gate:

- [ ] Full §10 sweep in CI (tests 1–10, incl. upgrades from partial in Phases 2–3); probes extended over the MCP surface (forged env in tool args, scope-stuffing, refresh replay after demotion)
- [ ] `docs/threat-model.md` (§4 invariants, enforcement mechanisms, out-of-scope)
- [ ] README: contributor + consumer quickstarts, bold security posture, **stub-vs-real table** (`real`/`simplified`/`stubbed` per component)
- [ ] MIT `LICENSE`; `docs/roadmap.md` documenting the open-core line
- [ ] Runbooks 11 + 12 executed end-to-end at least once
- [ ] Tag `v0.1.0`; publish image + npm

---

## §10 acceptance test → phase

| §10 test | Covered by |
|---|---|
| 1 broker-only path | Phase 0 |
| 2 deny by default | Phase 0 |
| 3 field-level enforcement | Phase 0 |
| 4 adversarial leak probe | Phase 0 (extended over MCP in 3, 8) |
| 5 dev/live wall + scope escalation | Phase 0 partial → Phase 2 |
| 6 env parity | Phase 3 |
| 7 grant lifecycle | Phase 0 (through real UI in 5) |
| 8 synthetic isolation | Phase 0 |
| 9 audit completeness | Phase 0 |
| 10 aggregation enforcement | Phase 0 |
| 11 MCP + SSO e2e (manual) | Phase 4 |
| 12 cloud deploy e2e (manual) | Phase 7 |

## Post-MVP

Backlog (§12) lives in [plans/2026-07-18-phases-mvp-and-post-mvp.md](./superpowers/plans/2026-07-18-phases-mvp-and-post-mvp.md#post-mvp-backlog-12--do-not-build-now-design-already-tolerates-these): row-level grant scoping, `broker.mutate` write path, connect-in-place, masking postures, aggregate-only posture, NL search adapter, app platform, IdP group→role mapping, more deploy targets, SAML/SCIM/compliance exports, hosted control plane.
