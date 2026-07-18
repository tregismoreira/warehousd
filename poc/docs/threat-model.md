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
