# Harbor Law — 20 things to try

Twenty scenarios against the [Harbor Law demo project](README.md), roughly in
order of difficulty. Each is self-contained: a goal, the steps, and **what to
look for** — the observable fact that makes the claim true rather than asserted.

Nothing here needs an assistant connected. Scenarios 1–15 run entirely in the
browser; 16 adds Claude, 17 adds `curl`, 18 adds one SQL statement, and 19–20
use the CLI you already ran.

## Before you start

```bash
cd examples/harbor
npx warehousd start          # a few minutes the first time, mostly image pulls
```

Open http://localhost:8722 and sign in. Every persona's password is `demo`.

| Persona | Role | Holds at first boot |
|---|---|---|
| `ana@demo.local` | admin | A read grant on every collection, `env: dev` |
| `marcus@demo.local` | manager | The same |
| `mia@demo.local` | member | **Nothing** |
| `priya@demo.local` | manager | Nothing |
| `dan@demo.local` · `elena@demo.local` · `omar@demo.local` | member | Nothing |

Mia holding nothing is the point, not an oversight — it is what makes the grant
flow demonstrable on a fresh install.

**Everything below is `env: dev` unless a scenario says otherwise.** The
environment switcher lives in the console header; it writes a signed cookie, and
the broker reads the cookie rather than anything a page sends.

Reset at any time with `warehousd seed` (regenerates synthetic data and
re-indexes), or start over completely with `warehousd stop --destroy --yes`.

### Landmarks worth knowing

Facts the scenarios lean on, so you can check a result rather than trust it:

| | |
|---|---|
| Denied fields | 16, including `matters.privileged_notes`, `salaries.ssn`, `people.home_address`, `clients.billing_address`, and the `path` of every file collection |
| Masked fields | `salaries.bank_account` (last 4, never unmaskable) and `salaries.pay_band` (banded, `unmask: allow`) |
| Canary strings | `DEV-DOC-CANARY-7f3a` in a dev policy · `LIVE-DOC-CANARY-2c9d` in a live policy · `DOC-RESTRICTED-CANARY-9e4b` in a privileged case file for client `c-0099` |
| Seed documents | 18 in dev (10 case files, 5 policies, 3 precedents), 5 in live |
| Client `c-0042` | 4 case files, 3 of them tagged `discovery`, across matters `M-2025-0184` and `M-2025-0301` |
| `policies` by department | 2 `hr`, 2 `finance`, 1 `corporate` |
| Writable collection | `matter_tasks` only |
| ACL collection | `announcements` only (40 documents, none restricted to begin with) |

---

## A. Deny by default

### 1. The empty room

**Goal** — See what "no grant" actually means: existence is not a secret,
content is.

**Do** — Sign in as **Mia**. Go to `/member`. Every one of the 20 collections is
listed with its name and description.

**Look for** — No collection returns a document, and no field name appears
anywhere. Mia can learn that `salaries` exists. She cannot learn that it has a
column called `ssn`, or how many rows it holds. `list_collections` over MCP is
the same answer to the same question.

**Variation** — As Ana (who holds grants), the same page shows fields and data.
Same code path, different grants.

### 2. The denied field that is not there

**Goal** — Confirm that a denied field is absent, not filtered.

**Do** — As **Ana**, go to **Admin → Collections → `matters` → Data**. Ana holds
a grant on the whole collection.

**Look for** — `privileged_notes` is not in the field list, not in the filter
dropdown, and not in any row. There is no "denied" placeholder and no error
mentioning it, because the column was never put in the `SELECT` — the broker
builds the statement from the granted field list, so there is no value in flight
to leak into a response, an error body or a log line. Open **Fields** and the
config shows it as `deny`, which is why it was never grantable to begin with.

**Variation** — Ask for it by name anyway, from the devtools console:

```js
await (
  await fetch("/api/collections/matters/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields: ["matter_number", "privileged_notes"] }),
  })
).json();
```

`field_denied`, with no value and no SQL. Try `salaries.ssn` and
`clients.billing_address` too. An admin cannot grant any of them to themselves;
changing that takes an edit to `warehousd.yml` and a `warehousd apply`.

### 3. "Why can't I see this?"

**Goal** — Get a per-field explanation without leaking a value.

**Do** — As **Mia**, open **My grants** and use the access explainer on
`salaries`. Then as **Ana**, open **Admin → Users → Mia** and ask the same
question about her.

**Look for** — Each field comes back with what the *config* allows (`allow` /
`mask` / `deny`), whether a grant carries it, and what Mia would actually
receive (`raw` / `masked` / `none`). No field *value* is in the answer — a
masked field shows the shape of the transform, never a real number. This is a
separate broker verb with its own authorization: there is no MCP tool for it, so
a model can never ask it.

---

## B. The grant loop

### 4. Request → approve → query

**Goal** — The core arc, end to end.

**Do**

1. As **Mia**: **Request access** → collection `matters`, purpose
   `onboarding prep`, tick `matter_number`, `client_name` and
   `responsible_attorney_name`.
2. Sign out. Sign in as **Marcus** → **Grants** → the request is in the inbox.
   Approve it as-is.
3. Back as **Mia**: query `matters`.

**Look for** — Mia now gets exactly three fields. Not the other five she could
have asked for, and not `privileged_notes`, which was never on the table. The
purpose she typed is stamped on every audit event the grant produces.

### 5. An approver trims, and cannot widen

**Goal** — Show that approval is a narrowing operation.

**Do** — Have Mia request `people` with every field ticked. As Marcus, untick
`hire_date` and `manager_name` before approving.

**Look for** — Mia gets the reduced set. Now try the other direction: approving
a field Mia did *not* request is refused with `cannot_widen`. A manager cannot
hand out access nobody stated a purpose for — the console will not offer the
checkbox, and the API refuses it if you post one.

### 6. Ending access: revoke, expire, review

**Goal** — Three ways access stops, and the fact that none of them wait for a
token.

**Do**

- **Revoke** — As Marcus, **Grants → Active**, revoke Mia's `matters` grant.
  Mia's very next query refuses.
- **Expire** — Approve a new grant with an expiry a few minutes out. When it
  passes, queries refuse without anybody doing anything. The row is still in
  Mia's history as an expired grant rather than deleted, so the trail keeps it.
- **Review** — Approve a grant expiring inside 7 days and check the manager's
  **expiring soon** panel; **Review access** lists approved grants by last use,
  so the ones nobody has exercised are the obvious ones to retire.

**Look for** — All three refuse with the same code, `no_grant`. Revoked, expired
and never-granted are deliberately indistinguishable to the caller: a distinct
"your access expired" would confirm that access once existed, which is itself a
fact about the collection. Grants load fresh on every request — there is nothing
to wait out, no cache to invalidate, no token refresh in the loop.

### 7. Nobody approves their own live access

**Goal** — See the separation-of-duties rule fire.

**Do** — As **Marcus** (a manager, so he can request and approve), switch the
console to **live**, request access to any collection, then try to approve your
own request.

**Look for** — `self_approval_denied`, 403. Ask **Priya**, the other manager, to
approve it and it goes through. The same rule blocks a proposal whose author is
its approver (scenario 18). `dev` is deliberately exempt — its data is generated
and regenerable, so the ceremony would be theatre.

---

## C. Narrowing a grant

### 8. A grant scoped to one client

**Goal** — Scope a file-collection grant to a taxonomy term and watch the rest of
the corpus vanish.

**Do** — Have Mia request `case_files` (`title`, `content`, `matter_number`).
As Marcus, before approving, pick the **client** vocabulary and select `c-0042`
only. Approve. As Mia, search `case_files` for something broad like `agreement`.

**Look for** — Every hit belongs to matter `M-2025-0184` or `M-2025-0301` — the
two matters for `c-0042`. Now search for `DOC-RESTRICTED-CANARY-9e4b`, a string
that exists verbatim in a privileged memo for client `c-0099`. Zero results.
Not "1 result you may not open" — zero. Mia has no way to learn that the
document, the client, or the matter exists.

**Variation** — The `client` vocabulary is *dataset-sourced*: its terms are rows
of the `clients` collection resolved by `client_number`, not a list in the YAML.
Admin → Taxonomies shows all 150.

### 9. Two predicates at once

**Goal** — Stack scopes across different vocabularies.

**Do** — Approve a `case_files` grant scoped to client `c-0042` **and** tag
`discovery`.

**Look for** — Three files instead of four: the engagement letter for the same
client is tagged `contract, real-estate` and drops out. The predicates are
ANDed, and the *field* each one gates comes from the config — an approver picks
values, never columns.

**Variation** — On `policies` (bound to `department` and `tags`), scope to
`department: hr` and get the 2 HR policies; the 2 finance ones are gone. Or scope
by **path** instead, picking individual files from the approver's picker.

### 10. Per-document ACLs: the count that drops by one

**Goal** — Take one document out of a grant that covers the whole collection.

**Do**

1. As **Ana**, query `announcements` and note the count — 40.
2. **Admin → Collections → `announcements` → Access**. Restrict one announcement
   to `user:mia`.
3. Query `announcements` again as Ana.

**Look for** — 39, not "40 with one hidden". A count that reported the total
would itself disclose how many documents you cannot see. `get_document` on that
id answers `not_found`, and it is gone from search too — one predicate, ANDed
into the same `WHERE` every read goes through. Sign in as Mia (with a grant on
the collection) and she sees it; nobody else does. Remove every principal and it
is public within the grant again.

**Why `announcements`** — it has rows. A collection whose documents all arrive by
proposal has nothing to count.

### 11. Groups as principals

**Goal** — Grant to a population rather than a person.

**Do** — As **Ana**, **Admin → Users**, put **Dan** and **Elena** in a group
called `litigation`. As **Marcus**, request access on behalf of `group:litigation`
(a manager-only move) and approve it.

**Look for** — Dan and Elena both see the grant under **My grants**, and neither
of them requested it. Add Omar to the group and he inherits it with no new
approval. Group membership is warehousd's own record in `app.user_groups` — it is
never read from a token claim, so a rogue IdP assertion cannot invent one.

**Variation** — Use `group:litigation` as an ACL principal in scenario 10.

---

## D. Field values

### 12. Masking, and what it costs

**Goal** — See the third read posture, between allow and deny.

**Do** — As **Ana**, browse `salaries`.

**Look for** — `bank_account` renders as `••••4321` and `pay_band` as a banded
number (25,000-wide buckets). Ana is an admin holding a grant on the collection
and still gets the transform, because the transform is computed **in SQL** — the
raw value never leaves Postgres, so it cannot appear in a response, an error
body, or a log line. `ssn`, which is `deny` rather than `mask`, is absent
entirely; masking and denial are different answers to different questions.

### 13. Unmasking is a second decision

**Goal** — Grant the raw value of a masked field, deliberately.

**Do** — Have Mia request `salaries` including `pay_band`. As Marcus, tick
`pay_band` in the field list — a **second** checkbox appears next to it for the
raw value. Tick that too and approve.

**Look for** — Mia sees real figures where Ana still sees bands, because Ana's
grant carries no unmask. The audit row records which fields the decision returned
unmasked, so "who saw raw compensation" is a query rather than an investigation.
`bank_account` offers no second checkbox at all: it declares `unmask: deny`, and
rendering a box that always fails would be worse than rendering none.

### 14. A masked field cannot be compared

**Goal** — Understand why masking is real rather than decorative.

**Do** — With a grant carrying masked `pay_band`, try to filter on it, order by
it, group by it, or aggregate it.

**Look for** — `field_denied` every time. Masked fields are **projection-only**.
This is the load-bearing rule: a banded salary you can still compare against
falls to bisection in about ten queries, and `like` walks a redacted string one
character at a time. A mask that survives only until someone sorts by it is not
a mask.

### 15. Aggregation, and its ceiling

**Goal** — Ask a real analytical question, and find the wall.

**Do** — In the browser devtools console, signed in as Ana:

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

**Look for** — Average revenue per region, over 730 days of synthetic metrics.
Now try `avg` over `salaries.base_salary` under a grant that does not carry
`base_salary`: refused. Aggregation is permitted **only over fields the caller
could already read row by row**, which is what guarantees an aggregate can never
reveal anything new. Aggregate-only postures — computing an average over a field
you cannot read — need minimum-group-size machinery and are deliberately
[not built](../../docs/roadmap.md).

---

## E. Beyond the console

### 16. Connect Claude, before and after

**Goal** — Watch an assistant inherit exactly one person's access.

**Do** — In Claude: **Settings → Connectors → Add custom connector**, paste
`http://localhost:8722/mcp`, complete the OAuth flow **as Mia before her grant
exists**. Ask it to find something in `case_files`. Then approve a grant as
Marcus and ask again — no reconnect, no new token.

**Look for** — First it can only tell you the collection exists; the refusal
carries a reason code and a request-access hint, never a value and never SQL.
After the approval the same question answers. There is no `approve` tool for it
to call: the model may propose, only an authenticated human may decide.

**Variation** — Ask a broad question without naming a collection.
`search_documents` takes an optional collection, so "what is our parental leave
policy" fans out across everything the caller holds a read grant on and merges
the results. Full walkthrough: [connect-claude.md](../../docs/connect-claude.md).

### 17. REST with a headless API key

**Goal** — Reach the same broker over `/v1`, under a collection ceiling.

**Do**

1. As **Ana**, **Admin → API keys** → new key, mode **headless**, robot user
   **mia**, allowed collections `matters` only. Copy the secret — it is shown
   once.
2. Mint a token and use it:

```bash
TOKEN=$(curl -s -u "$CLIENT_ID:$SECRET" \
  -d 'grant_type=client_credentials&scope=env:dev' \
  http://localhost:8722/v1/token | jq -r .access_token)

curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8722/v1/collections
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8722/v1/collections/policies/search?q=pto
```

**Look for** — The key acts under **Mia's** grants, not Ana's, and the ceiling
narrows even that: `policies` refuses even if Mia holds a grant on it. Two walls,
and the narrower one wins. Grants and the client policy are re-read on every
call, so revoking Mia's grant stops the key mid-flight; revoking the *secret*
stops new tokens being minted, and the one you hold expires within 15 minutes.
Audit rows for these calls carry `via: api_key:<clientId>`.

**Note** — The dev client printed by `warehousd start` is a *delegated* client
and will answer `unauthorized_client` to `client_credentials`. That is the right
refusal: it exists for the interactive OAuth flow in scenario 16.
Endpoints and status codes: [rest-api.md](../../docs/rest-api.md).

### 18. The governed write path

**Goal** — Let an assistant propose a change that a human commits.

`matter_tasks` is the only writable collection.

**Do**

1. Have Mia request `matter_tasks` (`title`, `notes`, `assignee`) and have
   Marcus approve it as usual.
2. A grant is approved `verbs: {read}, mode: direct`, and the approve sheet
   exposes neither, so widen it directly. The database URL is in the outputs
   block:

   ```bash
   psql "$(jq -r .databaseUrl .warehousd/outputs.json)" -c \
     "update app.grants set verbs = '{read,create}', mode = 'proposal_only'
      where user_id = 'mia' and collection = 'matter_tasks' and status = 'approved'"
   ```

   No `psql` to hand? Any Postgres client works, including
   `docker exec -it wh_harbor_db psql -U warehousd warehousd`.
3. As Mia (or through Claude, connected as Mia), create a `matter_tasks`
   document. Then sign in as **Marcus** → **Review**.

**Look for** — The write returns `pending`, not `created` — 202 over REST. The
proposed content is invisible to **everyone**, including Mia who wrote it, until
Marcus approves it in the console. Approving promotes it as a new revision;
nothing is overwritten, and a delete is a revision too rather than a physical
removal. Marcus cannot approve his own proposal.

**Variation** — Set `verbs` without `mode` and the write applies directly. Try
writing `matter_tasks.created_at`, which is read-only: `field_not_writable`. Try
writing to any other collection: `not_writable`.

---

## F. Operating it

### 19. dev and live are different databases

**Goal** — Confirm the isolation is structural rather than conventional.

**Do**

1. Index the live corpus — Harbor ships both environments wired, only dev
   populated:

   ```bash
   warehousd index policies --env live      # 2 documents
   warehousd index case_files --env live    # 2
   warehousd index precedents --env live    # 1
   ```

2. As **Ana**, switch the header to **live** and browse anything.
3. Request a `policies` grant *while the console is on live*, and have **Priya**
   approve it (scenario 7: nobody approves their own live access).

**Look for** — At step 2, every collection refuses. Ana holds a grant on all 20
of them and it is worth nothing here: a grant names its environment, and hers say
`dev`. Being an admin is not a live grant either. After step 3 the 2 live
policies appear — and the 5 dev ones do not.

There are **no dataset rows at all** in live, because nothing generates into it
by design; real rows arrive only through an import (scenario 20).

Now the sharp test: switch back to **dev** and search everything for
`LIVE-DOC-CANARY-2c9d`. Nothing, under any grant, ever. Search
`DEV-DOC-CANARY-7f3a` and you find it immediately. Two Postgres roles, two
connection pools, selected by the token's env scope — a schema-resolution bug
cannot cross that wall, because the database itself refuses.

**Variation** — Environment is never a request parameter. It is an OAuth scope in
a signed token, intersected server-side with the client's policy *and* the user's
live-grant eligibility, so a client without `env:live` can ask for it all day and
will only ever be issued `env:dev`.

### 20. Change the config, import real data, read the trail

**Goal** — The operator's loop: governance in git, data through a reviewed path,
every decision recorded.

**Change the config.** Flip `people.job_title` to `posture: deny` in
`warehousd.yml`, then:

```bash
warehousd apply     # no restart; the running server re-reads the file
```

The ceiling moves at once for every **new** decision: the field disappears from
Mia's request form, and approving it is refused with `field_not_grantable` even
if you post it directly. An **already-approved** grant keeps the field list it
was approved with until somebody revokes or re-approves it — the posture governs
what may be granted, and revoking is what withdraws what already was. Worth
knowing before you flip a posture in production and assume it drained.

Collection DDL stays additive, so type changes, renames and drops go through
`warehousd migrate` instead: see [migrations.md](../../docs/migrations.md).

**Import real data.**

```bash
warehousd import map ~/clients.xlsx --collection clients   # prints a proposal; writes nothing
warehousd import validate clients ~/clients.csv            # types, required fields, row cap
warehousd import run clients ~/clients.csv --dry-run       # executes and rolls back
warehousd import run clients ~/clients.csv --mode upsert
```

CSV, JSON and XLSX. `import map` is deny-by-default on anything that looks
sensitive — a header containing `ssn`, `salary`, `bank` or `address` comes back
`posture: deny`, `email` comes back masked to its domain, and it prints what it
closed and why. Every mode appends revisions: the import role holds no `UPDATE`
on a data column and no `DELETE` at all, so a correction supersedes a value
rather than overwriting it. (The console's import panel needs
`IMPORT_DATABASE_URL`, which `warehousd start` does not set — under the CLI, use
these commands.)

**Read the trail.** **Admin → Audit**, filtered by user, collection, outcome,
env or `via`.

**Look for** — Every scenario above left rows here, refusals included. A refusal
row names the reason, never the value. Turn the trail off with
`audit: { enabled: false }` and `auditId` is null throughout — deliberately
indistinguishable from nothing having happened, because nothing was recorded.
Point `audit: { sink: webhook, url: … }` at a listener and the same decisions
stream to a SIEM instead of a table.

---

## What the demo cannot show you

Honest boundaries, so you do not go looking:

| | |
|---|---|
| **SSO against a real IdP** | Harbor uses local passwords. OIDC and SAML are implemented and tested against Keycloak, but connecting a hosted IdP is a manual runbook — [configure-sso.md](../../docs/configure-sso.md) |
| **Token exchange (RFC 8693)** | Needs an IdP-issued JWT and a registered trusted issuer, so it follows SSO — [rest-api.md](../../docs/rest-api.md) |
| **Semantic and hybrid search** | Off unless `warehousd.yml` declares an `embedding:` block. Add one, then `warehousd embed` — [configuration.md](../../docs/configuration.md#semantic-search) |
| **Connect-in-place** | Reading an external database through `postgres_fdw` needs an external database to point at — [configuration.md](../../docs/configuration.md#connect-in-place) |
| **Multiple organizations** | `org_id` is threaded through every table and enforced by RLS, but a single implicit org is created at bootstrap and there is no UI for switching — [status.md](../../docs/status.md) |
| **PDF/DOCX and console upload** | Both work; Harbor's seed corpus is Markdown, so bring your own files via **Admin → Documents** — [configuration.md](../../docs/configuration.md#pdf-and-docx) |
| **SCIM, compliance exports** | Not built — [roadmap.md](../../docs/roadmap.md) |
