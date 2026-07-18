# warehousd — Phases after the POC (MVP Phases 1–8 + Post-MVP)

> **For agentic workers:** This is a *phase roadmap*, not a task-by-task implementation plan. Before executing any phase, convert it into a detailed TDD plan with the superpowers:writing-plans skill (as was done for Phase 0 in `2026-07-18-phase-0-poc.md`), then execute via superpowers:subagent-driven-development.

**Goal:** Take the Phase 0 enforcement core (broker, postures, dual roles, synthetic data, audit, persona-switched console) to the full MVP defined in `docs/SPECS.md`: real authentication (§6), the MCP surface (§7), the role-scoped web UI (§8), the CLI + distribution + Fly.io deploy (§11), gated by the complete §10 acceptance suite.

**Definition of done for the MVP:** all §10 acceptance tests pass (1–10 automated in CI; 11 and 12 as documented manual runbooks), and the README ships the stub-vs-real table.

**Phase ordering rationale:** auth is the spine everything else hangs on, so it comes first and is split into three phases (sessions → OAuth provider → SSO) because each has a distinct blast radius and its own testable deliverable. MCP needs the OAuth provider; the UI needs sessions and roles; the CLI/deploy phases need a finished server image. Phases 5 and 6 are independent of each other and can run in parallel.

---

## What Phase 0 already delivered (kept as-is)

`packages/broker` complete (query/describe/list, aggregation, grants eval, SQL builder, audit, dual `warehousd_dev`/`warehousd_live` pools), YAML loader + apply, synthetic generator, Meridian seed with canaries, CLI `apply`/`seed` subset, adversarial probe suite, §10 tests 1–4, 7–10 + test 5 partial. Throwaway pieces to be replaced in the MVP are marked `// POC-ONLY`: the persona-switcher adapter and the three-pane chat page's identity handling.

---

## Phase 1: Real identity — Better Auth core, roles, persona-switcher removal

**Spec:** §6 (items 2, 3 partially), §3 (Role).

**Scope:**
- Install Better Auth in `apps/web`; Better Auth-managed tables (`user`, `session`, `account`) migrate into the `app` schema alongside Drizzle.
- Local email/password credentials as the bootstrap path (per §6.2 this remains only as fallback; `SANDBOXD_DISABLE_LOCAL_LOGIN=true` support lands here even though SSO arrives in Phase 3).
- `role` field on user: `admin` | `manager` | `member`; seeded Meridian personas (Ana/Marcus/Priya) become real local-credential users with their §9 roles and pre-seeded grants.
- **Delete the POC persona switcher.** `BrokerContext` in UI routes is now derived from the verified session (`userId` from session; env from an explicit env toggle that only session-authenticated users can use — this toggle is itself replaced by token scopes in Phase 2 for API paths, but stays for the web console).
- Login screen; demo mode shows the persona credentials per §9.
- Authorization checks on the existing grants API route: only `manager`/`admin` can approve/deny/revoke.

**Key files:** `apps/web/lib/auth.ts` (Better Auth config), `apps/web/app/api/auth/[...all]/route.ts`, `apps/web/middleware.ts`, delete `apps/web/app/lib/persona.ts`, modify `apps/web/app/api/{chat,grants,audit}/route.ts` to derive context from session.

**Acceptance gate:**
- All Phase 0 tests still green (broker untouched).
- New integration tests: unauthenticated request to chat/grants/audit routes → 401; member calling grant-approve → 403; session-derived `BrokerContext.userId` matches the logged-in user (an env-like or userId-like value in the request body is provably ignored).
- Demo login as each persona works; Priya's pending `salaries` arc still demos end-to-end.

---

## Phase 2: OAuth 2.1 provider + env-as-scope (§6 items 4–6, §6.1)

**Spec:** §6.1 in full — this is the security-critical phase of the MVP.

**Scope:**
- Better Auth OIDC-provider/MCP plugin: warehousd becomes an OAuth 2.1 authorization server. Short-lived access tokens (15 min) + refresh tokens.
- `app.client_policies` table exactly per §6.1 (`allowed_scopes text[] default '{env:dev}'`, `promoted_at`, `promoted_by`).
- Scope-issuance hook implementing rules 1–4 of §6.1:
  1. requested scopes ∩ `client_policies.allowed_scopes`;
  2. `env:live` additionally requires the user to hold ≥1 approved, unexpired live grant;
  3. consent screen env picker when both survive — exactly one env scope in the token;
  4. scope rules re-run on every refresh.
- Dynamic client registration (RFC 7591) enabled; dynamically registered clients get `allowed_scopes = {env:dev, env:live}`; manually created clients get `{env:dev}` always.
- Token verification adapter: the §6.1 `BrokerContext` derivation snippet becomes real code — the *only* constructor of `BrokerContext` for token-authenticated paths; absent env scope defaults to `dev`.
- Promotion/demotion primitives (data layer + minimal API; the admin UI for it lands in Phase 5).

**Key files:** `apps/web/lib/oauth.ts` (provider config + scope hook), `packages/broker/src/db/app-schema.ts` (+`client_policies`), `apps/web/lib/broker-context.ts`, migration for `client_policies`.

**Acceptance gate — §10 test 5 completes here (automated):**
- Dev-only client requesting `scope=env:live` receives a token with only `env:dev` (asserted on issued token).
- After promotion, next refresh yields `env:live`; after demotion, next refresh drops it.
- User with no approved live grant never receives `env:live`, even from a live-allowed client.
- Token with no env scope → adapter resolves `dev`.
- Tokens carry only sub/client/env scope — no grant data (assert token payload).
- Revoked grant → within one refresh cycle, `env:live` gone (test with forced refresh).

---

## Phase 3: MCP endpoint (§7)

**Spec:** §7 complete; depends on Phase 2 tokens.

**Scope:**
- `/mcp` streamable-HTTP endpoint (MCP TypeScript SDK) in `apps/web`, OAuth-protected; `BrokerContext` from the verified token per Phase 2.
- Four tools, complete list: `list_collections`, `describe_collection(name)`, `query_collection(intent)`, `request_access(collection, purpose, fields?)`.
- `request_access` creates a `pending` grant row and returns the request id; refusals from `describe_collection`/`query_collection` include the `request_access` hint per §7.
- Tool descriptions state the governance model plainly (deny-by-default, purpose-bound) — write them carefully; the model reading them is the first consumer of the security posture.
- The Phase 0 chat console's tool loop is rewired to call the same tool implementations (shared module), so the console remains a local test bench for the MCP surface.

**Key files:** `apps/web/app/mcp/route.ts` (or `app/api/mcp`), `apps/web/lib/mcp-tools.ts` (tool defs + handlers shared with chat route).

**Acceptance gate:**
- Integration tests driving the MCP protocol over HTTP with a dev token: `list_collections` returns names+descriptions only; `describe_collection` is grant-filtered; a hostile `query_collection` intent from the probe suite is refused with reason codes and zero canary leakage; `request_access` produces a pending grant visible to Marcus.
- Env wall over MCP: dev-token session never returns live canaries across all four tools.
- §10 test 6 (env parity) automated here: identical intent under equivalent dev/live grants → identical response shapes.

---

## Phase 4: SSO — generic OIDC, JIT provisioning, IdP-delegated MCP login (§6 items 1–3)

**Spec:** §6 items 1–3; §10 test 11.

**Scope:**
- Better Auth SSO plugin: generic OIDC (works with Okta, Entra ID, Google Workspace). SAML only if the same plugin gives it for free; otherwise mark `stubbed` in the README table.
- Admin-configurable IdP (issuer URL, client id/secret) stored in DB, editable in the admin UI (form lands in Phase 5; the API + storage land here) — no code change, no redeploy.
- JIT provisioning: first SSO login creates the user as `member`.
- When an SSO provider is configured: login defaults to SSO; `SANDBOXD_DISABLE_LOCAL_LOGIN=true` fully disables local credentials.
- MCP OAuth authorize step delegates to the configured IdP: connecting Claude is "log in with your company account".

**Key files:** `apps/web/lib/sso.ts`, `app.sso_provider` config storage (Better Auth-managed), changes to the OAuth authorize flow from Phase 2.

**Acceptance gate:**
- Automated: JIT-provisioned user has role `member`; local login rejected when disabled flag set; IdP config CRUD is admin-only.
- **§10 test 11 (manual):** runbook `docs/connect-claude.md` + `docs/configure-sso.md` with screenshots — test OIDC IdP (e.g. a Keycloak container or Okta dev tenant) → Claude connector → OAuth lands on IdP login → `list_collections` works → denied-field probe from the Claude conversation fails cleanly.

---

## Phase 5: Admin / Manager / Member web UI (§8)

**Spec:** §8 complete; §6.1 client-admin surface. Apply the `frontend-design` skill — this is the demo stage; keep the Phase 0 "security console" aesthetic.

**Scope (three role-scoped surfaces):**
- **Admin:** collections & postures (read-only YAML state + apply status), SSO configuration form (Phase 4 API), user role management, "Regenerate dev data" button, audit log browser with filters (user/collection/outcome).
- **Admin → Clients:** list clients; "New client" (returns id+secret, `{env:dev}` always); per-client allowed scopes, promotion audit trail (`promoted_at/by`), last token issued, promote-to-live and demote-to-dev actions (manager or admin).
- **Manager:** grant request inbox → approve (set expiry, trim requested fields) / deny; active grants list with revoke.
- **Member:** my grants + statuses; how-to-connect page (MCP endpoint URL + copy-paste Claude connector setup).
- Navigation/layout replaces the single POC screen; the chat console survives as a dev-mode page.

**Key files:** `apps/web/app/(admin|manager|member)/**`, shared components; API routes for clients, roles, SSO config, regen-synth.

**Acceptance gate:**
- Route-level authorization tests: each surface 403s for lower roles.
- Grant approval with field-trimming and expiry through the UI drives §10 test 7 end-to-end at the UI/API layer.
- Promotion/demotion through the UI drives the Phase 2 scope tests through the real surface.
- Manual design review pass (frontend-design skill checklist).

---

## Phase 6: CLI lifecycle + distribution (§11, minus deploy)

**Spec:** §11 — Supabase-CLI consumption model. Can run in parallel with Phase 5.

**Scope:**
- `packages/cli` grows from the Phase 0 `apply`/`seed` subset to the full set: `init`, `start`, `stop [--destroy]`, `status`, `apply`, `seed`, `regen-synth`.
- `start`: read config → pull/start server image + Postgres (or use `database.url`) under the project namespace → apply + synthetic seed → print outputs block → write `.warehousd/outputs.json`. Idempotent.
- Outputs contract exactly per §11, including the auto-created `devClient` OAuth client with `allowed_scopes = {env:dev}` (uses Phase 2 machinery — local DX and prod security are the same code path).
- Docker: talk to Docker via `dockerode` or shell-out (pick one; detect-and-error clearly if Docker isn't running).
- **Publishing pipeline:** GitHub Actions builds and pushes `ghcr.io/<org>/warehousd` (the `apps/web` image) and publishes the `warehousd` npm package. Offline guarantee verified: after image pull, `warehousd start` works with network disabled.
- `examples/meridian` upgraded into a true consuming-project example driven entirely by `npx warehousd start`.

**Key files:** `packages/cli/src/{init,start,stop,status,apply,seed,regen}.ts`, `apps/web/Dockerfile`, `.github/workflows/{ci,release}.yml`.

**Acceptance gate:**
- E2E test (local, may be CI-optional): from a temp dir with only `warehousd.yml`, `warehousd init/start/status/apply/stop` full cycle; outputs.json matches the contract; devClient token mint works against the started stack; re-run `start` after a YAML posture change applies the diff.
- Offline check documented and manually verified.

---

## Phase 7: `warehousd deploy` — Fly.io (§11 Deploy)

**Spec:** §11 deploy section; §10 test 12. Depends on Phase 6 (published image) and Phase 4 (SSO checklist item).

**Scope:**
- `warehousd deploy` shelling out to `flyctl` (check installed+authenticated; error with install instructions otherwise).
- **Pre-flight production checklist — refuses unless all pass:** SSO configured *or* `--allow-local-login`; `SANDBOXD_DISABLE_DEMO=true` (no demo personas, no seeded `data_live`); all `${env:...}` resolve.
- Create/update Fly app from the published image; provision Fly Postgres (`database.managed: true`) or attach `database.url`; secrets via `fly secrets set` (never written to disk).
- Post-deploy: run `apply` + synthetic seed against the deployed instance — **`data_synth` only; deploy never writes `data_live`**.
- Outputs to `.warehousd/outputs.deploy.json` with public HTTPS URLs; idempotent re-deploys with printed config diff (`--yes` skips prompt); `deploy --destroy` requires typed app-name confirmation.

**Key files:** `packages/cli/src/deploy.ts`, `deploy:` block in the config zod schema, `docs/deploy-fly.md`.

**Acceptance gate:**
- Automated: checklist refusal paths (demo mode on → refuse; unresolved env → refuse; no SSO and no flag → refuse); dry-run diff rendering.
- **§10 test 12 (manual runbook):** from `examples/meridian`, deploy succeeds only after checklist passes (verify it refuses first with demo mode on); deployed `mcpUrl` connects from Claude over HTTPS; `data_live` empty on the deployed instance; re-deploy after a posture change applies the diff; `--destroy` teardown.

---

## Phase 8: Hardening, docs, release gate

**Spec:** §10 full suite, §11 docs, stub-vs-real requirement, license.

**Scope:**
- Full §10 sweep in CI: tests 1–10 automated (including the parts upgraded from partial in Phases 2–3); 11 and 12 finalized as runbooks with screenshots.
- Expanded adversarial probe rounds against the *MCP* surface (probes.json extended with protocol-level hostile inputs: forged env params in tool args, scope-stuffing, refresh-token replay after demotion).
- `docs/threat-model.md`: invariants §4, enforcement mechanisms, what's out of scope.
- README: quickstart for both personas (contributor `docker compose up`; consumer `npx warehousd start`), bold security posture summary, and the **stub-vs-real table** (every component marked `real` / `simplified` / `stubbed` — e.g. filter operators: real; SAML: stubbed unless Phase 4 got it free; connect-in-place: absent).
- MIT license file; `docs/roadmap.md` documenting the open-core line (approval workflows at scale, SCIM, compliance exports = future paid; everything shipped = OSS).
- Version `0.1.0` tag; publish image + npm.

**Acceptance gate:** green CI on the full suite, both runbooks executed at least once end-to-end, stub table accurate against the shipped code.

---

## Post-MVP backlog (§12 — do not build now; design already tolerates these)

Ordered roughly by unlock-value; each item becomes its own spec + plan when picked up.

1. **Row-level grant scoping** — nullable `row_filter jsonb` on `app.grants` (broker-validated predicate, e.g. `{field:"space", op:"eq", value:"hr"}`); unlocks CMS-style "these pages, not all pages". The MVP grants table already tolerates the column without restructuring.
2. **Write path** — `broker.mutate(ctx, mutation)` with its own validation + audit; required for content-hub adapters. Additive by design (audit column is `outcome`, not `query_outcome`).
3. **Connect-in-place collections** — views over external Postgres instead of imported tables; extends `warehousd.yml` with a `source:` per collection.
4. **Masking/transform postures** — field postures beyond allow/deny (hash, truncate, redact patterns).
5. **Aggregate-only posture** — compute `avg(base_salary)` without row access; requires minimum-group-size / inference-leak protection first (an average over a group of one *is* the value).
6. **NL search in the web UI** — optional adapter calling an LLM to produce a `QueryIntent`, routed through the same broker; stays out of the offline core (external API dependency).
7. **App platform** — agent-built apps registering as OAuth clients with app-scoped, purpose-bound access (the flagship differentiator); builds directly on §6.1 client policies + promotion flow.
8. **IdP group→role mapping** — SSO groups drive admin/manager/member automatically.
9. **Additional deploy targets** — Railway, generic Docker host, Pulumi/Terraform provider (MVP ships Fly.io only).
10. **SAML** (if not free in Phase 4), **SCIM provisioning**, **per-team cost caps**, **compliance export formats** — enterprise/paid-line candidates per `docs/roadmap.md`.
11. **Hosted control plane** — multi-tenant managed offering; revisit the MIT license before this ships.

---

## Cross-phase tracking: §10 acceptance test → phase

| §10 test | Covered by |
|---|---|
| 1 broker-only path | Phase 0 ✅ |
| 2 deny by default | Phase 0 ✅ |
| 3 field-level enforcement | Phase 0 ✅ |
| 4 adversarial leak probe | Phase 0 ✅ (extended over MCP in Phases 3, 8) |
| 5 dev/live wall + scope escalation | Phase 0 partial → completed in Phase 2 |
| 6 env parity | Phase 3 |
| 7 grant lifecycle | Phase 0 ✅ (through real UI in Phase 5) |
| 8 synthetic isolation | Phase 0 ✅ |
| 9 audit completeness | Phase 0 ✅ |
| 10 aggregation enforcement | Phase 0 ✅ |
| 11 MCP + SSO e2e (manual) | Phase 4 |
| 12 cloud deploy e2e (manual) | Phase 7 |
