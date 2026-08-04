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

- **Semantic search** over the reserved `vector(1536)` embedding column, which is
  created and never populated.
- **Document upload with PDF and DOCX extraction.** Indexing currently reads
  local directories of `.md` and `.txt`.
- **Connect-in-place collections** over an external Postgres, rather than
  requiring data to live in warehousd's own database.
- **Aggregate-only postures** with inference-leak protection — computing
  `avg(base_salary)` without row access. This needs minimum-group-size or
  differential-privacy machinery to be safe, which is why it is not built:
  aggregation is currently permitted only over fields the caller could already
  read row by row, so an aggregate can never reveal anything new.
- **More deploy targets** beyond Fly.io.
- **IdP group→role mapping.** JIT provisioning creates a `member` and roles are
  changed by hand.

## Not planned

See [SECURITY.md](../SECURITY.md#out-of-scope) for what is deliberately out of
scope, including the ones easily mistaken for gaps: distributed rate limiting,
defence against a malicious administrator, and hostile-tenant isolation.
