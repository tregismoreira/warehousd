# Warehousd Phase 0 Threat Model

## Trust Boundary

### Untrusted Components
- **LLM (Claude)**: proposer of SQL queries or structured filters; outputs are not trusted
- **Client (web browser)**: user-controlled input (natural language, form submissions)

### Trust Boundary (Broker)
The Postgres query broker is the **trust function**:
1. Client submits query (natural language or structured)
2. Broker re-validates:
   - Schema exists and is loaded
   - Requested fields are granted to the requesting persona
   - Filter operators are allowlisted (eq/neq/gt/lt/gte/lte/like/in)
   - Aggregation logic is applied only to granted fields
3. Broker executes the query via a **Postgres role-scoped connection**
4. **All queries are audited** before returning to the client

Client cannot:
- Issue direct SQL to Postgres
- Escalate to ungranted fields
- Use forbidden operators (e.g., `DROP TABLE`)
- See denied rows or columns in the result

### LLM Final-Answer Trust (Fabrication)

The LLM's **tool calls** are re-validated by the broker (see above), but its **final text
answer to the user is not** — nothing stops the model from ignoring a `no_grant`/`field_denied`
tool_result and inventing plausible-looking rows or numbers in prose instead of reporting the
refusal. This was observed in practice: asked for salary data with no grant, the model returned
a fabricated table of salaries, then only admitted the numbers were invented when challenged on
a follow-up turn.

Two mitigations, both in `apps/web/app/api/chat/route.ts`:

1. **Prompt-level**: `SYSTEM_PROMPT` explicitly instructs the model to never fabricate,
   guess, or simulate data not present in a `tool_result`, and to state plainly when it
   hasn't successfully queried something — even under repeated user pressure. This is a
   soft mitigation; models can still fail to follow it.
2. **Code-level guard**: `collectQueriedOk()` scans the full conversation (across turns,
   not just the current request) for `query_collection` tool_results with `ok:true`,
   building the set of collections actually queried successfully. When the model's final
   text contains a markdown table or multiple `$`-figures while that set is empty,
   `looksFabricated()` flags it and the server injects a corrective message forcing the
   model to re-answer honestly instead of streaming the fabrication to the user.

This guard is a heuristic (table/number detection), not a full grounding check — it targets
the specific failure mode observed above cheaply. It does not verify that displayed numbers
match the actual queried rows field-for-field.

### Postgres Role Isolation
Phase 0 implements **deny-by-default** via Postgres role-based access control:

- `warehousd_dev_*` roles can only issue queries that Postgres enforces
- `warehousd_live_*` roles have access to production data only
- **Two separate connection pools** prevent accidental cross-contamination
- Broker selects the pool (dev or live) based on the requesting persona's scope

If the broker bug grants an unapproved query, Postgres still denies it at the role level.

## Network Trust Boundary (Phase 0)

**Phase 0 has NO network trust boundary.**

- Postgres, broker, and web app run on **`127.0.0.1` only**
- Docker Compose binds all services to localhost
- HTTP traffic (client → broker) is **unencrypted** (no TLS)
- No OAuth; personas are switched via a dropdown (POC only)

This is acceptable for:
- Local development
- Proof-of-concept demonstrations
- Architectural validation

**Not acceptable for:**
- Production
- Multi-user deployments
- Public or shared networks

## Security Assumptions (Phase 0)

1. **Postgres is trusted**: broker code runs in the same environment as Postgres
2. **Localhost users are trusted**: all users with shell access to the machine are assumed non-adversarial
3. **No network adversary**: no MITM or eavesdropping (127.0.0.1 only)
4. **ANTHROPIC_API_KEY is protected**: kept in environment variables, never in code or logs

## Mitigations in MVP

- **TLS**: encrypt client ↔ broker traffic
- **OAuth**: authenticate users via external provider
- **Network isolation**: Postgres in private subnet, broker behind firewall
- **Rate limiting**: prevent query floods
- **Input length limits**: cap query/filter size to prevent DoS

## Deferred to Post-MVP

- **Row-level security (RLS)**: Postgres native RLS to mask denied rows
- **Column masking**: hash or encrypt sensitive columns for unauthorized users
- **Secrets management**: rotate API keys, use external vaults
- **Logging sink**: ship audit logs to immutable external system
- **DLP integration**: detect and block PII leakage patterns
