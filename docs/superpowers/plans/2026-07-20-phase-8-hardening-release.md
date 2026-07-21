# Phase 8 — Production Hardening, Docs, Release Gate (Execution Outline)

> **Status: outline.** Expand with superpowers:writing-plans before executing. Spec: `docs/SPECS.md` §10 full suite, §11 docs/license. Roadmap: Phase 8. This closes the MVP.

**Goal:** Operational hardening beyond the spec text, the full §10 sweep in CI, threat model + README + license, and the `v0.1.0` release.

**Depends on:** Phases 0.5–7 all complete.

## Tasks — hardening

- [ ] Versioned `app`-schema migrations (Drizzle Kit) so upgrades on an existing deploy preserve grants/audit — replaces create-if-not-exists-only (`createAppSchema` becomes migration 0)
- [ ] `/health` endpoint; wired into `warehousd status` and Fly health checks
- [ ] Auth abuse controls: rate limiting on login/token endpoints, lockout on local credentials — verify what Better Auth provides, fill gaps
- [ ] Session/CSRF hardening for the deployed HTTPS origin (cookie flags, trusted origins)
- [ ] Log-redaction policy covering framework logs (Next.js/Better Auth request bodies, OAuth error responses); probe assertions extended to capture and grep these logs
- [ ] Audit retention decision documented in the threat model (even if "no rotation in MVP")
- [ ] Backup guidance (Fly Postgres snapshots) added to `docs/deploy-fly.md`

## Tasks — release gate

- [ ] Full §10 sweep in CI: tests 1–10 + 12 + 14 automated (including parts upgraded from partial in Phases 2–3); probes extended over the MCP surface — forged env in tool args, scope-stuffing, refresh-token replay after demotion (`probes.json` additions)
- [ ] `docs/threat-model.md`: §4 invariants, enforcement mechanisms per invariant, explicit out-of-scope list (incl. the Phase 0 LLM final-answer trust section carried forward)
- [ ] README: contributor quickstart (`docker compose up`) + consumer quickstart (`npx warehousd start`), bold security posture summary, **stub-vs-real table** — every component marked `real` / `simplified` / `stubbed` (e.g. filter operators: real; SAML: stubbed unless Phase 4 got it free; connect-in-place: absent)
- [ ] MIT `LICENSE`; `docs/roadmap.md` documenting the open-core line (approval workflows at scale, SCIM, compliance exports = future paid; everything shipped = OSS)
- [ ] Runbooks 11 (Phase 4) and 13 (Phase 7) executed end-to-end at least once; results recorded
- [ ] Tag `v0.1.0`; publish image + npm via the Phase 6 release workflow

## Acceptance gate

Green CI on the full §10 suite (1–10, 12, 14), both manual runbooks executed, stub-vs-real table accurate against the shipped code, `v0.1.0` published.

## Expansion notes

- The migration-versioning task is the riskiest (rewrites `createAppSchema` usage everywhere including CLI + container entrypoint) — do it first in the expanded plan, before the docs tasks.
- MCP-surface probe extensions belong in the same data-driven `probes.json` pattern; add a `surface: "mcp"` runner.
