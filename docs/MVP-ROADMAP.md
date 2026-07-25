# warehousd MVP Roadmap

Phases and tasks from the Phase 0 POC to a production-ready MVP.

- Spec: [SPECS.md](./SPECS.md) — §-references below point there.
- Phase 0 plan (done first): [plans/2026-07-18-phase-0-poc.md](./superpowers/plans/2026-07-18-phase-0-poc.md)
- Phase detail + post-MVP backlog: [plans/2026-07-18-phases-mvp-and-post-mvp.md](./superpowers/plans/2026-07-18-phases-mvp-and-post-mvp.md)

> Before executing a phase, expand it into a task-by-task TDD plan with the `writing-plans` skill (as Phase 0 was) and execute via subagent-driven development. Tasks below are the checklist of deliverables, not step-level instructions.

**MVP code lives in `mvp/`** (fresh workspace; POC modules ported and re-reviewed per phase — `poc/` stays frozen as the Phase 0 reference). Per-phase execution plans:

| Phase | Plan |
|---|---|
| 0.5 | [plans/2026-07-20-phase-0.5-document-indexing.md](./superpowers/plans/2026-07-20-phase-0.5-document-indexing.md) (full TDD detail) |
| 1 | [plans/2026-07-20-phase-1-real-identity.md](./superpowers/plans/2026-07-20-phase-1-real-identity.md) (outline) |
| 2 | [plans/2026-07-20-phase-2-oauth-provider.md](./superpowers/plans/2026-07-20-phase-2-oauth-provider.md) (full TDD detail) |
| 3 | [plans/2026-07-20-phase-3-mcp-endpoint.md](./superpowers/plans/2026-07-20-phase-3-mcp-endpoint.md) (outline) |
| 4 | [plans/2026-07-20-phase-4-sso.md](./superpowers/plans/2026-07-20-phase-4-sso.md) (outline) |
| 5 | [plans/2026-07-20-phase-5-web-ui.md](./superpowers/plans/2026-07-20-phase-5-web-ui.md) (outline) |
| 6 | [plans/2026-07-20-phase-6-cli-distribution.md](./superpowers/plans/2026-07-20-phase-6-cli-distribution.md) (outline) |
| 7 | [plans/2026-07-20-phase-7-deploy-fly.md](./superpowers/plans/2026-07-20-phase-7-deploy-fly.md) (outline) |
| 8 | [plans/2026-07-20-phase-8-hardening-release.md](./superpowers/plans/2026-07-20-phase-8-hardening-release.md) (outline) |

Outline plans get expanded to full TDD detail (writing-plans) right before their phase starts.

**MVP definition of done:** all §10 acceptance tests pass (1–10, 12, 14 automated in CI; 11 and 13 as manual runbooks) and the README ships the stub-vs-real table (§10).

**Ordering:** Phase 0.5 (document indexing) is broker-level and independent of the auth spine — run it right after Phase 0, or in parallel with Phases 1–4. Phases 1→4 are sequential (auth spine). Phases 5 and 6 can run in parallel after 4. Phase 7 needs 4 + 6. Phase 8 closes.

---

## Phase 0 — POC (complete before MVP work) ✅ gate: §13

Enforcement core: broker, postures, dual DB roles, synthetic data, audit, persona-switched chat console. See the [Phase 0 plan](./superpowers/plans/2026-07-18-phase-0-poc.md). Throwaway pieces marked `// POC-ONLY` (persona switcher, console identity handling) are replaced in Phases 1–3.

---

## Phase 0.5 — Document indexing (§5.6) — gate: §10 test 14 — ✅ COMPLETE

Design: [specs/2026-07-18-document-indexing-design.md](./superpowers/specs/2026-07-18-document-indexing-design.md) — read it first; every step below is grounded there against the existing broker code. All production code kept in MVP. Sub-steps in dependency order; 0.5d can run in parallel with 0.5b–c.

Implemented via a 13-task subagent-driven-development plan ([plans/2026-07-20-phase-0.5-document-indexing.md](./superpowers/plans/2026-07-20-phase-0.5-document-indexing.md)), each task independently implemented and reviewed, plus a final whole-branch review. Full `mvp` test suite: **68/68 passing across 20 files, 0 known failures.** See "Try it yourself" below to run the demo.

- [x] **0.5a Config foundation:** `type: dataset|file` + `source` (dev content) + optional `source_live` on `CollectionSchema`; Zod refinements — file fields ⊆ `{title, content, path, owner, updated_at}`, `source` required for file collections, no `__` in collection names (design §8 test 12)
- [x] **0.5b Storage & DDL:** per-collection `{name}__files` + `{name}__documents` tables (avoids collision with the seeded `documents` collection; `path` unique = upsert key; tsv generated column + GIN index; reserved `embedding vector(1536)`, pgvector enabled); file+document join `v_{collection}` view; type branches in `tableDDL`/`viewDDL`; `grantViewDDL` unchanged — verify env role reads view but not base tables (design §8 test 7)
- [x] **0.5c Indexer:** `packages/broker/src/indexing` — scan the env-appropriate source dir (`source` = dev sample files, `--env live` requires `source_live`/`--source`; never one dir into both envs), extract `.md`/`.txt` (title from heading/filename, owner from frontmatter, updated_at from mtime), paragraph-aware chunking (~500–1000 chars, overlap), checksum-skip upsert + deletion sync; CLI entry (`warehousd index` or folded into `apply`/`seed`); dedicated write role, read roles gain nothing; distinct per-env demo dirs with distinct canaries (design §8 tests 5–6)
- [x] **0.5d Row-level grant scoping:** `row_filter jsonb` column + partial unique index `(user_id, collection, env) where status='approved'`; `loadActiveGrant`/`ActiveGrant` carry it; validated against the collection's YAML field set (not `allowed_fields`); ANDed into `buildSelect`'s `where[]`; empty in-list → constant-false; update the `q()` quote-helper safety comment. **Touches the shared structured-query path — run the full existing suite** (design §8 tests 3, 4, 8, 10)
- [x] **0.5e `broker.searchDocuments`:** new factory method reusing `query`'s validation helpers; `q`-guarded `buildSelect` branch (single param slot, tsv match, `ts_rank_cd` ordering, reserved `_rank`/`document_seq` keys stripped from `fieldsReturned`; no aggregate/groupBy); type matrix — `searchDocuments` on dataset collections → `invalid_intent`, `query` on file collections works unchanged (design §8 tests 1, 2, 9, 11, 12)
- [x] **0.5f Chat integration:** `search_documents` as the fourth tool in the POC chat route; Grants panel gets a file picker (`path` multi-select) for file-collection grants; seed a demo file collection so the Meridian arc covers it
- [x] Gate: design §8 acceptance list green in CI + all Phase 0 tests still green

### Try it yourself

**Automated: run the full test suite**

```bash
cd mvp
pnpm test:up                # start Postgres (pgvector) test container, port 54330
pnpm test                    # 68 tests across 20 files, all green
pnpm lint
pnpm test:down                # stop the container when done
```

**Manual: run the demo chat console**

1. Start Postgres and bootstrap the demo data (creates roles/schemas, applies `warehousd.yml`, seeds synthetic + demo data, indexes the `policies` file collection into both envs, seeds grants for Ana/Marcus/Mia):
   ```bash
   cd mvp
   docker compose -f docker-compose.test.yml up -d --wait
   WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian \
   APP_DATABASE_URL=postgres://postgres:postgres@localhost:54330/warehousd_test \
     pnpm tsx scripts/dev-bootstrap.ts
   ```
2. Start the chat console (needs an Anthropic API key for the chat model; the broker/grants/search paths work without it, but the chat UI's tool-calling loop does not):
   ```bash
   ANTHROPIC_API_KEY=sk-ant-... \
   WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian \
   APP_DATABASE_URL=postgres://postgres:postgres@localhost:54330/warehousd_test \
     pnpm --filter web dev
   ```
   Open http://localhost:8722.
3. In the console, switch persona (top of page) and try:
   - **Mia (member), env=dev** — ask *"what does the remote work policy say?"* → `search_documents` returns ranked documents from `remote-work.md` with title/content/owner/updated_at only (Mia's grant excludes `path`).
   - **Ana or Marcus (admin/manager), env=dev** — same query, broader access (managers/admins are seeded with full grants across all collections, including `policies`).
   - **A persona/collection combination with no approved grant** (e.g. ask about `salaries` as Mia — her grant on that collection is seeded `pending`, not `approved`) → refusal, with a hint to request access. Check the **Evidence** panel for the audit trail of every call, allowed or refused.
   - **Grants panel** — as Marcus/Ana, open Grants, approve a pending request for a file collection (`policies`), and try the new path multi-select: pick specific files to scope a `row_filter`-restricted grant, or leave it empty for full access.
   - **Env isolation** — switch to `env=live` and repeat a `policies` search; dev-seeded canary text (`DEV-DOC-CANARY-7f3a`, planted in `examples/meridian/seed/docs-dev/`) must never appear, and vice versa for the live canary (`LIVE-DOC-CANARY-2c9d`, in `seed/docs-live/`) when on `env=dev`.
4. Stop everything: `docker compose -f docker-compose.test.yml down -v` (add `-v` to also drop the demo data volume).

## Phase 0.6 — Taxonomy: vocabularies & terms — ✅ COMPLETE

Design: [specs/2026-07-22-taxonomy-design.md](./superpowers/specs/2026-07-22-taxonomy-design.md) · Plan: [plans/2026-07-22-taxonomy.md](./superpowers/plans/2026-07-22-taxonomy.md)

Term-based access control with zero new enforcement machinery: `taxonomies:` YAML block (vocabulary + term slugs/labels) upserted by `apply` into `app.vocabularies`/`app.terms` (`parent_id` reserved for hierarchy); collections bind a vocabulary (`taxonomy: category`) gaining a term column named after the vocabulary slug; indexer/synthetic/seed validate terms at write time; grant scoping to terms reuses `row_filter` (`{ field: <slug>, op: in }`). Demo: Meridian `category` vocabulary (12 terms) bound to `documents` + `policies`; Mia's policies grant scoped to `hr`+`benefits`; Grants panel term multi-select.

### Try it yourself

**Automated: taxonomy is covered by the shared test suite**

```bash
cd mvp
pnpm test:up          # start Postgres test container (port 54330)
pnpm test             # 94 tests across 21 files — includes taxonomy-grants.test.ts (7 tests)
pnpm test:down
```

The taxonomy-grants suite (`packages/broker/test/taxonomy-grants.test.ts`) proves:
- `row_filter {field:category, op:in, value:[hr]}` returns only matching rows; non-matching silently absent
- Client filters AND with the term scope — can never widen it
- Term column can gate rows without being readable (deny posture on the field)
- Empty in-list denies all rows (constant-false guard)
- Document search (`searchDocuments`) is also scoped — "vacation" in both hr and finance documents returns only the hr one for an hr-scoped grant
- Term-scoped calls appear in the audit log

**Manual: term-scoped grants in the Meridian demo**

Bootstrap the demo (same command as Phase 0.5 — already seeds taxonomy):

```bash
cd mvp
docker compose -f docker-compose.test.yml up -d --wait
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian \
APP_DATABASE_URL=postgres://postgres:postgres@localhost:54330/warehousd_test \
  pnpm tsx scripts/dev-bootstrap.ts
```

Bootstrap seeds three `policies` files, each with a `category` frontmatter tag:
- `remote-work.md` → `category: hr`
- `pto.md` → `category: benefits`
- `expenses.md` → `category: finance`

It also seeds Mia's grant scoped to `hr` + `benefits` only.

Start the console:

```bash
ANTHROPIC_API_KEY=sk-ant-... \
WAREHOUSD_PROJECT_DIR=$(pwd)/examples/meridian \
APP_DATABASE_URL=postgres://postgres:postgres@localhost:54330/warehousd_test \
  pnpm --filter web dev
```

Open http://localhost:8722 and try these scenarios:

- **Mia, env=dev** — search *"what is the expense reimbursement policy?"* → **no results** (expenses.md has `category:finance`, outside Mia's `hr`+`benefits` scope). Search *"what is the remote work policy?"* → returns content from `remote-work.md` (hr) and *"what is PTO?"* → returns `pto.md` (benefits). The term scope silently excludes finance; Mia never learns the finance file exists.
- **Ana or Marcus, env=dev** — same searches return content from all three files (their grants have no term filter).
- **Grants panel (term multi-select)** — as Marcus/Ana, open the Grants panel. Approve any pending grant on `policies`: the panel shows a **Category** multi-select listing all 12 terms. Select `hr` + `benefits` to issue a term-scoped approval, or leave the picker empty for full access. The `row_filter` is derived server-side from the config — the client cannot forge the field name.
- **Stop**: `docker compose -f docker-compose.test.yml down -v`

## Phase 1 — Real identity: Better Auth core + roles (§6.2–6.3)

- [ ] Install Better Auth in `apps/web`; auth tables (`user`, `session`, `account`) in the `app` schema
- [ ] Local email/password login (bootstrap fallback only) + login screen; demo mode shows §9 persona credentials
- [ ] `role` on user (`admin`/`manager`/`member`); seed Ana/Marcus/Mia as real users with §9 roles + grants
- [ ] Support `WAREHOUSD_DISABLE_LOCAL_LOGIN=true` (fully disables local credentials)
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

## Phase 3 — MCP endpoint (§7) — ✅ COMPLETE

Plan: [plans/2026-07-20-phase-3-mcp-endpoint.md](./superpowers/plans/2026-07-20-phase-3-mcp-endpoint.md)

- [x] `/mcp` streamable-HTTP endpoint (MCP TypeScript SDK), OAuth-protected, `BrokerContext` from token
- [x] Tools (complete list): `list_collections`, `describe_collection`, `query_collection`, `search_documents` (§5.6.3, from Phase 0.5), `request_access`
- [x] Refusals include the `request_access` hint; tool descriptions state deny-by-default + purpose-bound governance plainly
- [x] Rewire the chat console's tool loop onto the shared tool implementations (console = local MCP test bench)
- [x] Tests: MCP-over-HTTP integration (grant-filtered describe, probe-suite refusals over both `query_collection` and `search_documents`, zero canary leakage, pending grant from `request_access`); dev-token env wall across all tools (incl. forged env args); §10 test 6 (env parity — identical shapes dev vs live)

## Phase 4 — SSO: OIDC, JIT, IdP-delegated MCP login (§6 items 1–4, §6.1)

- [x] Better Auth SSO plugin: generic OIDC (Okta / Entra ID / Google Workspace); SAML shipped in the same plugin and tested end-to-end against Keycloak — both `real`, not `stubbed`
- [x] IdP config (issuer, client id/secret) stored in DB, admin-editable — no code change, no redeploy (API here; form in Phase 5)
- [x] JIT provisioning: first SSO login creates a `member`
- [x] SSO configured → login defaults to SSO; local login off when disabled
- [x] MCP OAuth authorize step delegates to the IdP ("log in with your company account")
- [x] Tests: JIT role = member; local-login rejection; IdP CRUD admin-only
- [x] §10 test 11 (manual): runbooks `docs/connect-claude.md` + `docs/configure-sso.md` — written; screenshots and the live Claude-connector pass still need to be captured by a human running the runbook once

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
- [ ] Pre-flight checklist — refuse unless: SSO configured or `--allow-local-login`; `WAREHOUSD_DISABLE_DEMO=true`; all `${env:...}` resolve
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
- [ ] README: contributor + consumer quickstarts, bold security posture, **stub-vs-real table** (`real`/`simplified`/`stubbed` per component) — Phase 4 shipped both SSO protocols with a full Keycloak-tested e2e pass (`docs/superpowers/plans/2026-07-20-phase-4-sso.md` Task 8/9): mark SSO OIDC `real` and SAML `real`, not `stubbed` (that was the pre-research assumption in this file's Phase 4 section, superseded once Task 9 landed)
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
| 12 LLM fabrication guard | Phase 0 |
| 13 cloud deploy e2e (manual) | Phase 7 |
| 14 document indexing & search | Phase 0.5 |

## Post-MVP

Backlog (§12) lives in [plans/2026-07-18-phases-mvp-and-post-mvp.md](./superpowers/plans/2026-07-18-phases-mvp-and-post-mvp.md#post-mvp-backlog-12--do-not-build-now-design-already-tolerates-these): ~~row-level grant scoping~~ (shipped in Phase 0.5), semantic/vector search (populate the reserved `embedding` column), file upload UI + PDF/DOCX extraction, `broker.mutate` write path, connect-in-place, masking postures, aggregate-only posture, NL search adapter, app platform, IdP group→role mapping, more deploy targets, SAML/SCIM/compliance exports, hosted control plane.
