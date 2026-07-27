# TODO — follow-up work requiring a human decision

Generated while executing the Phase 6 "CLI Lifecycle + Distribution" plan
(`.superpowers/sdd/phase-6-cli-plan/`). These are out of scope for that plan
and were deliberately not touched during its execution.

## 1. Close the two-tier grant/deny posture gap

**What:** `approveGrant`/`requestGrant` (broker package) currently accept
any `allowedFields` the caller supplies. There's no validation that
`allowedFields ⊆ grantableFields(cfg, collection)`, so a grant could in
principle include fields the config marks `posture: deny`.

**Why it matters:** During Task 12 we confirmed `v_<collection>` views are
*intentionally* flat (every field present regardless of posture) — access
control is meant to be enforced entirely at the grant/query layer, not by
omitting columns from the view. That design only holds if grants are
actually validated against `grantableFields()`. Right now they aren't, so
the two-tier deny model is not fully real yet.

**Scope:** A broker-package behavior change (`approveGrant`/`requestGrant`
plus their own tests). Does not touch the CLI, Docker, or view DDL.

**Source:** explicit note in the human decision that resolved the Task 12
plan-vs-codebase conflict — see
`.superpowers/sdd/phase-6-cli-plan/task-12-brief.md` and the ledger entry
for Task 12 in `.superpowers/sdd/phase-6-cli-plan/progress.md`.

## 2. Minor, non-blocking items parked during the final whole-branch review

Neither of these is a correctness bug; both were judged acceptable to ship
as-is but are worth a deliberate decision later:

- **`warehousd stop --destroy`** requires an explicit `--yes` flag rather
  than falling back to an interactive y/N prompt when omitted
  (`packages/cli/src/stop.ts`). Fine for scripts/CI; slightly unfriendly
  for interactive use.
- **`as any` type casts** in `apps/web/lib/auth.ts`, `lib/oauth.ts`,
  `lib/broker-context.ts`, `lib/session.ts` — worked around a loosely-typed
  Better Auth plugin API surface. No known runtime impact, but hides real
  type errors if the Better Auth API shape changes underneath them.
