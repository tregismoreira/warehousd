# Harbor Law — 20 things to try

Twenty scenarios against the [Harbor Law demo](README.md), easiest first. Each gives you the steps and **what to look for** — the observable fact behind the claim.

1–15 run in the browser · 16 adds Claude · 17 adds `curl` · 18 adds one SQL statement · 19–20 use the CLI.

## Setup

```bash
cd examples/harbor
npx warehousd start          # a few minutes the first time, mostly image pulls
```

Open http://localhost:8722. Every persona's password is `demo`.

| Persona | Role | Holds at first boot |
|---|---|---|
| `ana@demo.local` | admin | A read grant on every collection, `env: dev` |
| `marcus@demo.local` | manager | The same |
| `mia@demo.local` | member | **Nothing** |
| `lanna@demo.local` | manager | Nothing |
| `dan@demo.local` · `elena@demo.local` · `omar@demo.local` | member | Nothing |

Mia holding nothing is what makes the grant flow demonstrable on a fresh install.

Everything below is `env: dev` unless a scenario says otherwise; the switcher in the console header writes a signed cookie, and the broker reads the cookie rather than anything a page sends. Reset with `warehousd seed`, or start over with `warehousd stop --destroy --yes`.

### Landmarks

Facts the scenarios lean on, so you can check a result rather than trust it:

| | |
|---|---|
| Denied fields | 16, including `matters.privileged_notes`, `salaries.ssn`, `people.home_address`, `clients.billing_address`, and the `path` of every file collection |
| Masked fields | `salaries.bank_account` (last 4, never unmaskable) and `salaries.pay_band` (banded, `unmask: allow`) |
| Canary strings | `DEV-DOC-CANARY-7f3a` in a dev policy · `LIVE-DOC-CANARY-2c9d` in a live policy · `DOC-RESTRICTED-CANARY-9e4b` in a privileged case file for client `c-0099` |
| Seed documents | 18 in dev (10 case files, 5 policies, 3 precedents), 5 in live |
| Client `c-0042` | 4 case files, 3 tagged `discovery`, across matters `M-2025-0184` and `M-2025-0301` |
| `policies` by department | 2 `hr`, 2 `finance`, 1 `corporate` |
| Writable collection | `matter_tasks` only |
| ACL collection | `announcements` only (40 documents, none restricted to begin with) |

---

## A. Deny by default

### 1. The empty room

**Do** — Sign in as **Mia** → `/member`.

**Look for** — All 20 collections listed, with names and descriptions only. No documents, no field names. Mia can learn that `salaries` exists; not that it has an `ssn` column, nor how many rows it holds. `list_collections` over MCP answers the same. As Ana, the same page shows fields and data — same code path, different grants.

### 2. The denied field that is not there

**Do** — As **Ana**, **Admin → Collections → `matters` → Data**. She holds a grant on the whole collection.

**Look for** — `privileged_notes` is in no field list, no filter dropdown and no row. No placeholder, no error naming it: the column never entered the `SELECT`, so there is no value in flight to leak into a response, an error body or a log line. **Fields** shows it as `deny`, which is why it was never grantable.

Ask for it by name anyway, from the devtools console:

```js
await (
  await fetch("/api/collections/matters/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields: ["matter_number", "privileged_notes"] }),
  })
).json();
```

`field_denied`, with no value and no SQL. Same for `salaries.ssn` and `clients.billing_address`. No admin can grant them to themselves; that takes an edit to `warehousd.yml` and a `warehousd apply`.

### 3. "Why can't I see this?"

**Do** — As **Mia**, **My grants** → the access explainer on `salaries`. Then as **Ana**, **Admin → Users → Mia** → the same question about her.

**Look for** — Per field: what the config allows (`allow` / `mask` / `deny`), whether a grant carries it, and what Mia would actually receive (`raw` / `masked` / `none`). No field *value* appears — a masked field shows the shape of the transform, never a real number. This is its own broker verb with its own authorization, and there is no MCP tool for it, so a model can never ask it.

---

## B. The grant loop

### 4. Request → approve → query

**Do**

1. As **Mia**: **Request access** → `matters`, purpose `onboarding prep`, tick `matter_number`, `client_name` and `responsible_attorney_name`.
2. As **Marcus**: **Grants** → the request is in the inbox. Approve as-is.
3. Back as **Mia**: query `matters`.

**Look for** — Exactly three fields. Not the other five she could have asked for, and not `privileged_notes`, which was never on the table. The purpose she typed is stamped on every audit event the grant produces.

### 5. An approver trims, and cannot widen

**Do** — Mia requests `people` with every field ticked. As Marcus, untick `hire_date` and `manager_name` before approving.

**Look for** — Mia gets the reduced set. Approving a field she did *not* request is refused with `cannot_widen` — the console will not offer the checkbox, and the API rejects it if you post one. Approval only narrows.

### 6. Ending access: revoke, expire, review

**Do**

- **Revoke** — As Marcus, **Grants → Active**, revoke Mia's `matters` grant.
- **Expire** — Approve a new grant expiring a few minutes out, then wait.
- **Review** — Approve one expiring inside 7 days and check the manager's **expiring soon** panel. **Review access** lists approved grants by last use, so the unexercised ones are the obvious ones to retire.

**Look for** — All three refuse with the same code, `no_grant`. Revoked, expired and never-granted are deliberately indistinguishable to the caller: a distinct "your access expired" would confirm that access once existed, which is itself a fact about the collection. Grants load fresh on every request — nothing to wait out, no cache to invalidate. Expired grants stay in Mia's history rather than being deleted, so the trail keeps them.

### 7. Nobody approves their own live access

**Do** — As **Marcus** (a manager, so he can both request and approve), switch the console to **live**, request access to any collection, then try to approve your own request.

**Look for** — `self_approval_denied`, 403. Ask **Lanna**, the other manager, and it goes through. The same rule blocks a proposal whose author is its approver (scenario 18). `dev` is exempt on purpose — its data is generated and regenerable, so the ceremony would be theatre.

---

## C. Narrowing a grant

### 8. A grant scoped to one client

**Do** — Mia requests `case_files` (`title`, `content`, `matter_number`). As Marcus, before approving, pick the **client** vocabulary and select `c-0042` only. As Mia, search `case_files` for something broad like `agreement`.

**Look for** — Every hit belongs to matter `M-2025-0184` or `M-2025-0301`, the two for `c-0042`. Now search `DOC-RESTRICTED-CANARY-9e4b`, which exists verbatim in a privileged memo for client `c-0099`. Zero results — not "1 result you may not open". The document, the client and the matter are all unlearnable.

The `client` vocabulary is *dataset-sourced*: its terms are rows of the `clients` collection resolved by `client_number`, not a list in the YAML. **Admin → Taxonomies** shows all 150.

### 9. Two predicates at once

**Do** — Approve a `case_files` grant scoped to client `c-0042` **and** tag `discovery`.

**Look for** — Three files instead of four: the engagement letter for the same client is tagged `contract, real-estate` and drops out. Predicates are ANDed, and the *field* each one gates comes from the config — an approver picks values, never columns.

On `policies` (bound to `department` and `tags`), scope to `department: hr` and get the 2 HR policies; the finance ones are gone. Or scope by **path**, picking individual files from the approver's picker.

### 10. Per-document ACLs: the count that drops by one

**Do**

1. As **Ana**, query `announcements` and note the count — 40.
2. **Admin → Collections → `announcements` → Access** → restrict one to `user:mia`.
3. Query `announcements` again as Ana.

**Look for** — 39, not "40 with one hidden". A count reporting the total would itself disclose how many documents you cannot see. `get_document` on that id answers `not_found`, and it is gone from search too — one predicate, ANDed into the same `WHERE` every read goes through. Mia sees it; nobody else does. Remove every principal and it is public within the grant again.

`announcements` because it has rows — a collection whose documents all arrive by proposal has nothing to count.

### 11. Groups as principals

**Do** — As **Ana**, **Admin → Users**, put **Dan** and **Elena** in a group called `litigation`. As **Marcus**, request access on behalf of `group:litigation` (a manager-only move) and approve it.

**Look for** — Both see the grant under **My grants**, and neither requested it. Add Omar to the group and he inherits it with no new approval. Membership is warehousd's own record in `app.user_groups` — never read from a token claim, so a rogue IdP assertion cannot invent one. Works as an ACL principal in scenario 10 too.

---

## D. Field values

### 12. Masking, and what it costs

**Do** — As **Ana**, browse `salaries`.

**Look for** — `bank_account` renders as `••••4321`, `pay_band` as a 25,000-wide band. Ana is an admin holding a grant and still gets the transform, because it is computed **in SQL** — the raw value never leaves Postgres, so it cannot appear in a response, an error body or a log line. `ssn` is `deny` rather than `mask`, so it is absent entirely: different answers to different questions.

### 13. Unmasking is a second decision

**Do** — Mia requests `salaries` including `pay_band`. As Marcus, tick `pay_band` — a **second** checkbox appears next to it for the raw value. Tick that too, and approve.

**Look for** — Mia sees real figures where Ana still sees bands, because Ana's grant carries no unmask. The audit row records which fields the decision returned unmasked, so "who saw raw compensation" is a query rather than an investigation. `bank_account` offers no second checkbox at all — it declares `unmask: deny`.

### 14. A masked field cannot be compared

**Do** — With a grant carrying masked `pay_band`, try to filter on it, order by it, group by it, or aggregate it.

**Look for** — `field_denied` every time. Masked fields are **projection-only**, and this is the load-bearing rule: a banded salary you can still compare against falls to bisection in about ten queries, and `like` walks a redacted string one character at a time. A mask that survives only until someone sorts by it is not a mask.

### 15. Aggregation, and its ceiling

**Do** — In the devtools console, signed in as Ana:

```js
await (
  await fetch("/api/collections/metrics/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      aggregate: [{ fn: "avg", field: "revenue" }],
      groupBy: ["region"],
    }),
  })
).json();
```

**Look for** — Average revenue per region over 730 days of synthetic metrics. Now try `avg` over `salaries.base_salary` under a grant that does not carry `base_salary`: refused. Aggregation is permitted **only over fields the caller could already read row by row**, which is what guarantees an aggregate reveals nothing new. Aggregate-only postures need minimum-group-size machinery and are deliberately [not built](../../docs/roadmap.md).

---

## E. Beyond the console

### 16. Connect Claude, before and after

**Do** — In Claude: **Settings → Connectors → Add custom connector**, paste `http://localhost:8722/mcp`, complete the OAuth flow **as Mia before her grant exists**. Ask it to find something in `case_files`. Then approve a grant as Marcus and ask again — no reconnect, no new token.

**Look for** — First it can only tell you the collection exists; the refusal carries a reason code and a request-access hint, never a value and never SQL. After the approval the same question answers. There is no `approve` tool for it to call: the model may propose, only an authenticated human may decide.

`search_documents` takes an optional collection, so a broad question that names none — "what is our parental leave policy" — fans out across everything the caller can read and merges the results. Full walkthrough: [connect-claude.md](../../docs/connect-claude.md).

### 17. REST with a headless API key

**Do**

1. As **Ana**, **Admin → API keys** → new key, mode **headless**, robot user **mia**, allowed collections `matters` only. Copy the secret — shown once.
2. Mint a token and use it:

```bash
TOKEN=$(curl -s -u "$CLIENT_ID:$SECRET" \
  -d 'grant_type=client_credentials&scope=env:dev' \
  http://localhost:8722/v1/token | jq -r .access_token)

curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8722/v1/collections
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8722/v1/collections/policies/search?q=pto
```

**Look for** — The key acts under **Mia's** grants, not Ana's, and the ceiling narrows even those: `policies` refuses even if Mia holds a grant on it. Two walls, and the narrower one wins. Grants and client policy are re-read on every call, so revoking Mia's grant stops the key mid-flight; revoking the *secret* stops new tokens being minted, and the one you hold expires within 15 minutes. Audit rows carry `via: api_key:<clientId>`.

The dev client printed by `warehousd start` is a *delegated* client and answers `unauthorized_client` to `client_credentials` — the right refusal, since it exists for the interactive flow in scenario 16. [rest-api.md](../../docs/rest-api.md).

### 18. The governed write path

`matter_tasks` is the only writable collection.

**Do**

1. Mia requests `matter_tasks` (`title`, `notes`, `assignee`); Marcus approves.
2. Grants approve as `verbs: {read}, mode: direct` and the approve sheet exposes neither, so widen it directly:

   ```bash
   psql "$(jq -r .databaseUrl .warehousd/outputs.json)" -c \
     "update app.grants set verbs = '{read,create}', mode = 'proposal_only'
      where user_id = 'mia' and collection = 'matter_tasks' and status = 'approved'"
   ```

   No `psql`? `docker exec -it wh_harbor_db psql -U warehousd warehousd`.
3. As Mia (or through Claude, connected as Mia), create a `matter_tasks` document. Then as **Marcus** → **Review**.

**Look for** — The write returns `pending`, not `created` — 202 over REST. The proposed content is invisible to **everyone**, Mia included, until Marcus approves it. Approval promotes it as a new revision: nothing is overwritten, and a delete is a revision too rather than a physical removal. Marcus cannot approve his own proposal.

Set `verbs` without `mode` and the write applies directly. `created_at` is read-only (`field_not_writable`); any other collection is `not_writable`.

---

## F. Operating it

### 19. dev and live are different databases

**Do**

1. Index the live corpus — Harbor ships both environments wired, only dev populated:

   ```bash
   warehousd index policies --env live      # 2 documents
   warehousd index case_files --env live    # 2
   warehousd index precedents --env live    # 1
   ```

2. As **Ana**, switch the header to **live** and browse anything.
3. Request a `policies` grant *while the console is on live*, and have **Lanna** approve it (scenario 7).

**Look for** — At step 2, every collection refuses. Ana holds a grant on all 20 and it is worth nothing here: a grant names its environment, and hers say `dev`. Being an admin is not a live grant either. After step 3 the 2 live policies appear — and the 5 dev ones do not.

Now the sharp test: switch back to **dev** and search everything for `LIVE-DOC-CANARY-2c9d`. Nothing, under any grant, ever. Search `DEV-DOC-CANARY-7f3a` and you find it immediately. Two Postgres roles, two connection pools, selected by the token's env scope — a schema-resolution bug cannot cross that wall, because the database itself refuses.

Live holds **no dataset rows at all**; nothing generates into it by design, and real rows arrive only through an import (scenario 20). Environment is never a request parameter — it is an OAuth scope in a signed token, intersected server-side with the client's policy *and* the user's live-grant eligibility.

### 20. Change the config, import real data, read the trail

**Change the config.** Flip `people.job_title` to `posture: deny` in `warehousd.yml`, then:

```bash
warehousd apply     # no restart; the running server re-reads the file
```

The ceiling moves at once for every **new** decision: the field disappears from Mia's request form, and approving it is refused with `field_not_grantable` even if you post it directly. An **already-approved** grant keeps the field list it was approved with until somebody revokes or re-approves it — the posture governs what may be granted, revoking is what withdraws what already was. Worth knowing before you flip a posture in production and assume it drained.

Collection DDL stays additive, so type changes, renames and drops go through `warehousd migrate`: [migrations.md](../../docs/migrations.md).

**Import real data.**

```bash
warehousd import map ~/clients.xlsx --collection clients   # prints a proposal; writes nothing
warehousd import validate clients ~/clients.csv            # types, required fields, row cap
warehousd import run clients ~/clients.csv --dry-run       # executes and rolls back
warehousd import run clients ~/clients.csv --mode upsert
```

CSV, JSON and XLSX. `import map` is deny-by-default on anything that looks sensitive — a header containing `ssn`, `salary`, `bank` or `address` comes back `posture: deny`, `email` comes back masked to its domain, and it prints what it closed and why. Every mode appends revisions: the import role holds no `UPDATE` on a data column and no `DELETE` at all, so a correction supersedes a value rather than overwriting it. (The console's import panel needs `IMPORT_DATABASE_URL`, which `warehousd start` does not set — under the CLI, use these commands.)

**Read the trail.** **Admin → Audit**, filtered by user, collection, outcome, env or `via`.

**Look for** — Every scenario above left rows here, refusals included, and a refusal row names the reason but never the value. Turn the trail off with `audit: { enabled: false }` and `auditId` is null throughout — deliberately indistinguishable from nothing having happened, because nothing was recorded. Point `audit: { sink: webhook, url: … }` at a listener and the same decisions stream to a SIEM instead of a table.

---

## What the demo cannot show you

| | |
|---|---|
| **SSO against a real IdP** | Harbor uses local passwords. OIDC and SAML are implemented and tested against Keycloak, but connecting a hosted IdP is a manual runbook — [configure-sso.md](../../docs/configure-sso.md) |
| **Token exchange (RFC 8693)** | Needs an IdP-issued JWT and a registered trusted issuer, so it follows SSO — [rest-api.md](../../docs/rest-api.md) |
| **Semantic and hybrid search** | Off unless `warehousd.yml` declares an `embedding:` block. Add one, then `warehousd embed` — [configuration.md](../../docs/configuration.md#semantic-search) |
| **Connect-in-place** | Reading an external database through `postgres_fdw` needs an external database to point at — [configuration.md](../../docs/configuration.md#connect-in-place) |
| **Multiple organizations** | `org_id` is threaded through every table and enforced by RLS, but a single implicit org is created at bootstrap and there is no UI for switching — [status.md](../../docs/status.md) |
| **PDF/DOCX and console upload** | Both work; Harbor's seed corpus is Markdown, so bring your own files via **Admin → Documents** — [configuration.md](../../docs/configuration.md#pdf-and-docx) |
| **SCIM, compliance exports** | Not built — [roadmap.md](../../docs/roadmap.md) |
