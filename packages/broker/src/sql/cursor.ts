// A keyset pagination cursor: opaque, but deliberately NOT secret and NOT signed.
//
// Do not "harden" this into a signed or encrypted token. A forged cursor decodes to a
// `(sortField, pk)` pair that becomes `(sortField, pk) > ($n, $m)` in the WHERE clause
// (sql/build.ts) — exactly the predicate a caller could already write with a `gt` filter on the
// same field. Every other predicate is ANDed in regardless of where the cursor came from: the
// grant's document filters, the ACL predicate and every posture (sql/build.ts:190-224). A signed
// cursor would protect a value the caller could already choose, at the cost of a key to manage
// and rotate for no security gain.
//
// What a cursor must never do is create a comparison on a MASKED field — that is not this
// module's job to prevent. It is enforced in the verb (verbs/read.ts), which is the only place
// that knows which fields this caller's grant masks.
export type Cursor = { v: 1; f: string; d: "asc" | "desc"; k: [unknown, unknown] };

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

// Never throws. A cursor is client-supplied input from here on, and a malformed one is the
// caller's mistake (invalid_intent), not ours (internal_error) — so every failure mode below
// returns null rather than letting JSON.parse or a bad base64 payload throw out of this function.
// Validated structurally, field by field: casting `as Cursor` would trade a runtime check for a
// compile-time claim the input never earned.
export function decodeCursor(s: string): Cursor | null {
  let json: string;
  try {
    json = Buffer.from(s, "base64url").toString("utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) return null;
  if (typeof obj.f !== "string") return null;
  if (obj.d !== "asc" && obj.d !== "desc") return null;
  if (!Array.isArray(obj.k) || obj.k.length !== 2) return null;
  return { v: 1, f: obj.f, d: obj.d, k: [obj.k[0], obj.k[1]] };
}
