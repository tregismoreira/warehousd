// One identifier validator, for the places that build DDL or SQL text around a name.
//
// Every identifier this codebase interpolates comes from config that was validated at load time
// (CollectionSchema pins field and collection names to the same shape) or from a literal in the
// source. That is why nothing here is a live injection path today. It is also exactly the argument
// that stops being true the first time a caller passes something else, so the check is applied at
// the point of interpolation rather than trusted to hold upstream.
//
// This is the only copy. `q()` in sql/build.ts and `ident()` in broker.ts were byte-identical
// third and second copies of the same rule, which is one rule too many for something whose whole
// job is to be the place a name is checked before it becomes SQL text.
//
// A failure here is a broker bug, not a caller's: everything that reaches it is either a literal
// in the source or a config-validated name. Throwing surfaces it as internal_error rather than
// letting a malformed statement reach Postgres.
const IDENT = /^[a-z_][a-z0-9_]*$/i;

export function ident(id: string): string {
  if (!IDENT.test(id)) throw new Error(`unsafe identifier: ${id}`);
  return `"${id}"`;
}

// A single-quoted SQL string literal, for the handful of places a value cannot be a bound
// parameter — a column DEFAULT in DDL is the case that exists. Doubling embedded quotes is the
// whole of the escaping rule for a standard-conforming literal.
export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
