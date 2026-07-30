// `noUncheckedIndexedAccess` types `rows[0]` as possibly-undefined, which is right: a suite that
// indexes into a query result and gets nothing should say so, not throw
// `Cannot read properties of undefined`. This is the narrowing that also produces a useful message.
//
// Prefer it to `!`: the assertion silences the checker and, when the row really is missing, reports
// the symptom three lines later instead of the cause here.
export function must<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`expected ${what}, got ${String(value)}`);
  return value;
}
