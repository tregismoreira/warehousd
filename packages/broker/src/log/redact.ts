// The log-redaction policy, in code. Documented in docs/architecture.md, "Logging".
//
// Two categories, deliberately in one list:
//   - credentials and grant material (passwords, tokens, cookies, client secrets)
//   - the field names the example config denies (home_address, ssn, phone), so an object that
//     somehow escaped the broker's field gating still cannot carry a denied value into a log line
//
// This is defence in depth, not the primary control. The primary control is that the broker never
// SELECTs a denied field in the first place (invariant 4, docs/architecture.md) — redaction is
// key-name-based and will not catch a denied value arriving under a name it does not know.
//
// packages/cli/src/ui/mask.ts does the same job on the operator side, for values the CLI prints.
// The two are separate because the dependency runs CLI → broker and not back; they are kept
// deliberately consistent in behaviour.
// The third category is the one that is easy to miss: a node-postgres error carries row values in
// its own fields. `detail` is where Postgres reports them ("Key (home_address)=(...) already
// exists"), `where` is the PL/pgSQL context around them, and `internalQuery` is SQL text. The
// error's `message` is deliberately NOT redacted — it names the constraint rather than the value,
// and it is what makes the log worth keeping.
const SENSITIVE_KEY =
  /^(password|new_?password|token|access_?token|refresh_?token|id_?token|code|code_?verifier|client_?secret|secret|secret_?hash|authorization|cookie|set-cookie|ssn|home_?address|phone|detail|where|internal_?query)$/i;

const REDACTED = "[redacted]";
const MAX_DEPTH = 8;

/** Deep copy of `value` with sensitive keys replaced. Never mutates the input. */
export function redact(value: unknown): unknown {
  return walk(value, 0, new WeakSet());
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? redactString(value) : value;
  }
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : walk(v, depth + 1, seen);
  }
  return out;
}

/**
 * Masks credentials embedded in free text — connection strings and bearer tokens.
 *
 * Matched with a regex rather than `new URL` for the reason packages/cli/src/ui/mask.ts spells
 * out: `new URL` re-encodes on the way back out, and it parses `user:secret@host` as scheme
 * `user:` carrying no password at all, which returns the credential untouched.
 */
export function redactString(s: string): string {
  return (
    s
      // scheme://user:password@host
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:@\s/]+:)[^@\s]+@/gi, `$1${REDACTED}@`)
      // bare user:password@host, no scheme
      .replace(/(^|\s)([^\s:/@]+:)[^@\s/]+@/g, `$1$2${REDACTED}@`)
      // Authorization: Bearer <token>
      .replace(/\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, `$1${REDACTED}`)
  );
}
