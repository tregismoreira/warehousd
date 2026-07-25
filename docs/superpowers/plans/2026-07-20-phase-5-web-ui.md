# Phase 5 — Admin / Manager / Member Web UI (Execution Outline)

> **Status: outline.** Expand with superpowers:writing-plans before executing. Spec: `docs/SPECS.md` §8, §6.1 client-admin surface. Roadmap: Phase 5. **Parallel with Phase 6.** Apply the `frontend-design` skill; keep the Phase 0 "security console" aesthetic.

**Goal:** Three role-scoped surfaces replacing the single POC screen: Admin (collections, SSO, roles, clients, audit, import), Manager (grant inbox), Member (my grants + connect guide).

**Depends on:** Phase 4 (SSO config API), Phase 2 (client policies, promotion primitives), Phase 1 (roles).

## Tasks

- [ ] Navigation/layout shell with role-aware routing; chat console kept as a dev-mode page
- [ ] **Admin:** collections & postures view (YAML state from `app.collections` + apply status), SSO config form (Phase 4 API), user role management, "Regenerate dev data" button, audit browser with filters (user/collection/outcome)
- [ ] **Admin → Clients (§6.1):** list; "New client" (returns id+secret, `{env:dev}` always); per-client allowed scopes, promotion audit trail (`promoted_at/by`), last token issued; promote-to-live / demote-to-dev actions (manager or admin)
- [ ] **Real-data import path** (spec §11: "real data arrives via the admin import path"): admin-only CSV/JSON upload per `dataset` collection into `data_live`, validated against the YAML schema, written via a dedicated write role — audited, covered by leak probes (the only write path into live data)
- [ ] **Manager:** grant request inbox → approve (trim fields, set expiry, document `path` picker for `file` collections — Phase 0.5 machinery) / deny; active grants list with revoke
- [ ] **Member:** my grants + statuses; how-to-connect page (MCP endpoint URL + copy-paste Claude connector setup)

**Key files:** `mvp/apps/web/app/(admin)/**`, `(manager)/**`, `(member)/**`, shared components; API routes for clients, roles, SSO config, regen-synth, import.

## Acceptance gate

- Route-level authorization tests: each surface 403s for lower roles.
- §10 test 7 (grant lifecycle) driven end-to-end through the UI/API layer: request → approve with trimmed fields + expiry → query works → revoke → immediate `no_grant`.
- Promotion/demotion through the UI drives the Phase 2 scope tests through the real surface.
- Import path: schema-validation rejects bad rows; every import audited; leak probes cover imported live data (canary discipline).
- Manual design review pass (frontend-design skill checklist).
- All prior tests green.

## Expansion notes

- The import write role is a new Postgres role (e.g. `warehousd_import`, INSERT-only on `data_live` base tables) — mirror the indexer-role reasoning from Phase 0.5; read roles gain nothing.
- Split the expansion into two plans if it grows: (a) surfaces + navigation, (b) clients admin + import path.
