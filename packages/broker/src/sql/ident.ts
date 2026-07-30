// One identifier validator, for the places that build DDL or SQL text around a name.
//
// Every identifier this codebase interpolates comes from config that was validated at load time
// (CollectionSchema pins field and collection names to the same shape) or from a literal in the
// source. That is why nothing here is a live injection path today. It is also exactly the argument
// that stops being true the first time a caller passes something else, so the check is applied at
// the point of interpolation rather than trusted to hold upstream.
//
// Phase 4.1 folds the two remaining copies into this one: `q()` in sql/build.ts and `ident()` in
// broker.ts. They are identical in behaviour; moving the query builder onto a shared helper is a
// change to the file that generates every read statement, so it belongs with that phase's
// extract-and-verify pass rather than alongside an unrelated fix.
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
