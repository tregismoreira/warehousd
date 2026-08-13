# Provision workspaces (operator runbook)

Turn one warehousd deployment into several isolated tenants, provisioned and managed by a consuming application rather than by hand in the console. Requires `workspaces.enabled: true`.

This runbook drives the whole lifecycle from the platform API and the CLI — mint a credential, create a workspace, seed it, hand it a client, connect an MCP client to it — the same sequence a SaaS operator's own provisioning code would run.

---

## Prerequisite: turn the flag on

```yaml
workspaces: { enabled: true }
```

in `warehousd.yml`, then `warehousd apply`. Off is the default; on exposes the switcher, the Members page, and `/v1/platform/*` — see [configuration.md](configuration.md#workspaces) for exactly what it does and does not gate. Every `/v1/platform/*` route 404s, indistinguishable from a route that does not exist, until this is set.

---

## 1. Mint a platform key

```bash
warehousd platform-key create --label integrator --all-workspaces --days 30
```

```json
{ "id": "2bf52dce-…", "secret": "whd_plat_…", "managedWorkspaces": null, "expiresAt": "…" }
```

The secret is printed once. `--all-workspaces` reaches every tenant on the deployment; `--workspaces w-alpha,w-beta` scopes it to specific ids instead — see [cli.md](cli.md#platform-key-createlistrevoke). This is a bearer credential above the workspace boundary: treat it like a database password, not like an OAuth client secret. It authenticates `/v1/platform/*` only — presented to `/v1/collections` or `/mcp` it is rejected as unauthenticated, the same as no credential at all.

## 2. Create a workspace

```bash
curl -X POST http://localhost:8722/v1/platform/workspaces \
  -H "authorization: Bearer $PLATFORM_KEY" -H "content-type: application/json" \
  -d '{"id":"w-alpha","name":"Alpha Co","admin":{"userId":"alice"}}'
```

```json
{ "id": "w-alpha", "name": "Alpha Co" }
```

`admin.userId` becomes the workspace's first admin member — an id your application already knows, not necessarily one with a warehousd account yet: `workspace_members.user_id` carries no foreign key to `app.user`, so this works whether the user signs in for the first time tomorrow or already exists. A duplicate `id` is `409 workspace_exists`. Full route table: [rest-api.md](rest-api.md#platform-api-v1platform).

## 3. Seed it (optional)

```bash
curl -X POST http://localhost:8722/v1/platform/workspaces/w-alpha/seed \
  -H "authorization: Bearer $PLATFORM_KEY"
```

Regenerates `dev` synthetic data for this workspace only — the same generator `warehousd seed` runs, scoped so it never touches a sibling workspace's rows. `dev` only; there is no `live` counterpart. A fresh workspace has no data at all until this runs or something else writes to it — that includes file collections, which this does not index (below).

## 4. Provision an OAuth client

```bash
curl -X POST http://localhost:8722/v1/platform/workspaces/w-alpha/clients \
  -H "authorization: Bearer $PLATFORM_KEY" -H "content-type: application/json" \
  -d '{"displayName":"alpha-integrator"}'
```

```json
{ "clientId": "…", "secretId": "…", "secret": "whd_dev_…", "env": "dev" }
```

The secret is returned once, here, and never again. This client is pinned to `w-alpha` for its whole life — it cannot be pointed at a different workspace later. It has no interactive holder (no console login), so it authenticates through the interactive OAuth/PKCE flow like any delegated client; a caller that needs a pure machine credential instead mints a headless key from the console (`POST /api/api-keys`, admin-only, `mode: "headless"`) once a human member exists in the workspace to hold it.

## 5. Point an MCP client at the workspace

For a human member (console-registered client, interactive OAuth): sign the member into the console, switch their active workspace if they belong to more than one (step 6), then connect as in [connect-claude.md](connect-claude.md) — the resulting token resolves to whichever workspace was active at authorization time.

For a headless integration minted in step 4's fallback above:

```bash
curl -X POST http://localhost:8722/v1/token \
  -d "grant_type=client_credentials&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&scope=env:dev"
```

```json
{ "access_token": "…", "expires_in": 900, "scope": "env:dev" }
```

The token is workspace-bound from the moment it's issued — nothing in a `query_collection` or `search_documents` call names a workspace, and nothing could: the broker's own SQL carries no workspace predicate at all (see [architecture.md](architecture.md#workspaces-and-tenant-isolation)). Point an MCP client (or a raw `POST /mcp` JSON-RPC call) at this token, and `search_documents` in every mode — `text`, `semantic`, `hybrid` — returns only `w-alpha`'s documents, provably: a document id from a sibling workspace fetched through this token comes back `not_found`, not `field_denied` or an empty list, because the row is not merely ungranted — it does not exist from here.

## 6. Add a human member, and let them switch

```bash
curl -X POST http://localhost:8722/v1/platform/workspaces/w-alpha/members \
  -H "authorization: Bearer $PLATFORM_KEY" -H "content-type: application/json" \
  -d '{"userId":"bob","role":"manager"}'
```

A member of more than one workspace gets a switcher in the console header; a member of exactly one sees the workspace named with no control to switch, since there is nowhere to switch to. Switching changes which workspace's rows every console view reads — collections, grants queue, audit trail — for that session only, until switched again or the session ends.

---

## What every step above actually proves

Each platform mutation writes exactly one audit row, via `makeAuditWriter` like every other decision in the deployment — `userId: "platform:<keyId>"`, `via: "platform_key:<keyId>"`, `workspace_id` naming the tenant the call was made against. A data-plane call through a workspace's own token audits with that workspace's id and `via` naming how the caller authenticated (`oauth`, `api_key:<clientId>`, `token_exchange`) — never `platform_key:…`, since the platform key never reaches the data plane at all (§1).

## What this does not cover

- **Deleting a workspace** (`DELETE /v1/platform/workspaces/{id}`) removes every declared table's rows in both `data_synth` and `data_live`, then the `app.workspaces` row — irreversible, and not part of this runbook because there is nothing to walk through. See [rest-api.md](rest-api.md#platform-api-v1platform).
- **Hostile-tenant isolation.** This design serves cooperative tenants on one shared Postgres — no per-tenant rate limiting, no noisy-neighbour protection. See [SECURITY.md](../SECURITY.md) and [roadmap.md](roadmap.md#not-planned).
- **`source_ref` collections.** An external collection's live view is pinned to one tenant in config; it does not generalise to N workspaces. See [configuration.md](configuration.md#connect-in-place).
