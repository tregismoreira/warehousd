# Roadmap

What is planned, and where the open-source line sits. For what is built *today*,
the component status table in [README.md](../README.md#component-status) is the
authoritative list — it marks each component `real`, `simplified`, `stubbed` or
`not built`, and it is checked against the code rather than against intentions.

## The open-core line

**Everything shipped is MIT, and stays MIT.** That is the commitment, and it is
not conditional on what gets built later. The broker and its enforcement,
postures and grants, dev/live isolation, the audit trail, file collections and
search, taxonomies, the OAuth provider, the MCP endpoint, the REST API, API keys
and token exchange, SSO, the web UI, the CLI, and `warehousd deploy` are all in
that set. So is everything listed under [Planned](#planned) below.

If a hosted or paid offering ever exists, these are the shapes it would take —
listed here so the boundary is visible now rather than discovered later:

- approval workflows at organizational scale (delegation, escalation, on-call
  rotations for grant review)
- SCIM provisioning and compliance exports
- real multi-tenancy — one deployment serving mutually distrusting organizations
- a hosted control plane

None of that removes anything from the open-source side. The test is simple: if
it is in the repository today, it is MIT tomorrow.

## Planned

- **Aggregate-only postures** with inference-leak protection — computing
  `avg(base_salary)` without row access. This needs minimum-group-size or
  differential-privacy machinery to be safe, which is why it is not built:
  aggregation is currently permitted only over fields the caller could already
  read row by row, so an aggregate can never reveal anything new.

- **Org resolution at the auth boundary.** `org_id` is already threaded through
  every table, every query and `withOrg`, and tenant isolation is enforced by
  row-level security rather than by a predicate the broker remembers — but the
  value is always `'default'`. What is missing is the step that decides which org
  a caller belongs to, from their session, token or IdP claim. The expensive and
  security-relevant half is paid for; this is the cheap half, and it is deliberately
  not the same thing as the hostile-tenant isolation listed under
  [Not planned](#not-planned).

- **Streaming imports.** `validateImportRows` is synchronous and pure by design —
  which is what makes it testable without a database — so it materialises the
  whole payload in memory, and `DEFAULT_MAX_ROWS` caps a single import at 10,000
  rows. For a spreadsheet-heavy deployment the answer is to chunk the file into
  batches in the CLI, not to raise the constant: the ceiling is what keeps one
  import from being one very large transaction.

- **Audit retention and export.** `audit.sink` now chooses where a decision goes
  (`postgres`, `stdout-json`, `webhook`), which covers forwarding to a SIEM. What
  it does not cover is the other two halves of the same question: a retention
  policy for `app.audit_events`, and an export the console can produce for an
  auditor who wants the trail as a file rather than as a table.

- **Grant expiry notifications.** Expiry now has a lifecycle — a per-collection
  default, an expiring-soon panel, and an access-review view keyed on last use —
  but every part of it is something a person has to come and look at. Telling the
  holder and the approver that access lapses on Friday needs an outbound channel
  the deployment does not have yet, which is why it is a separate item.

## Undecided

Not planned, not rejected — the shape of the answer is the open question.

- **Self-service catalogue authoring.** Adding a collection in production means
  editing `warehousd.yml`, rebuilding and redeploying, so an IT admin cannot
  self-serve and every new data source is an engineering ticket. Moving the
  config into the database would fix that and would discard the property that
  makes the product credible — that governance is reviewed in git. The direction
  we lean is the one `warehousd import map` already takes: the console *composes*
  a change and prints it for review, and `warehousd apply` stays the only thing
  that commits it. What is undecided is how far that goes — a diff view, a
  proposal loop with approvals, or nothing beyond what exists.

## Not planned

See [SECURITY.md](../SECURITY.md#out-of-scope) for what is deliberately out of
scope, including the ones easily mistaken for gaps: distributed rate limiting,
defence against a malicious administrator, and hostile-tenant isolation.
