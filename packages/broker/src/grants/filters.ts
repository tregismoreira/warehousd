import type { CollectionConfig, FieldConfig } from "../config/schema";
import type { DocumentFilter } from "../types";

// A grant's document filters decide which rows the grant reaches. The read path evaluates them
// in SQL (sql/build.ts appends them to the WHERE clause); the write path evaluates them here, in
// process, against a row it has already fetched for other reasons — it cannot reuse the read
// path's SQL because it reads the base table for the `_rev*` bookkeeping columns, while the
// read path reads the view, which hides pending and deleted revisions.
//
// Two evaluators for one rule is a correctness problem: whenever they disagree, the same grant
// admits a row on read and refuses it on write. The previous implementation compared
// `String(value) === String(actual)`, which disagrees for every non-text type:
//
//   timestamptz  driver returns a Date; String(Date) is "Tue Jul 29 2026 …", never the filter's
//                ISO string                                        → read allows, write refuses
//   date         same, and the driver parses `date` at *local* midnight
//   numeric      driver returns a string ("100.00"); a filter value of 100 stringifies to "100"
//   boolean      Postgres accepts 't'/'yes'/'on'; String(true) is "true"
//   json         String({…}) is "[object Object]" for *any* object, so the filter matched every
//                row — an over-match, and the only one of these in the unsafe direction
//
// Parity here is not achieved by reimplementing Postgres's input parsing — that is not tractable
// (`'tr'::boolean` is true, `'1e2'::numeric` is 100, and a timestamp with no zone resolves in the
// *server's* timezone while JavaScript would resolve it in the process's). It is achieved by
// canonicalising both sides to a string that compares exactly, and refusing any filter value this
// module cannot canonicalise with certainty. `validateDocumentFilters` is called on the read path
// too, so an uninterpretable filter refuses `invalid_intent` on *both* paths rather than
// diverging quietly. The set of filters that can be evaluated is therefore the set on which the
// two paths provably agree.
//
// Cross-reference: sql/build.ts is the other evaluator. A change to either belongs in both, and
// test/filter-parity.test.ts asserts their agreement against a live Postgres.

// Postgres's own boolean input accepts unambiguous prefixes ("tr", "fa", "ye"). Matching that
// exactly buys nothing for a grant author and costs a subtle divergence, so the canonical
// spellings are accepted and anything else is refused on both paths.
const TRUE_LITERALS = new Set(["t", "true", "y", "yes", "on", "1"]);
const FALSE_LITERALS = new Set(["f", "false", "n", "no", "off", "0"]);

const UUID_HEX = /^[0-9a-f]{32}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// An instant is only unambiguous with an explicit offset. A zone-less timestamp is resolved by
// Postgres in the server's TimeZone and by JavaScript in the process's, so the two evaluators
// would disagree by whole hours whenever those differ — refused rather than guessed at.
//
// The offset must be `Z` or a full ±HH:MM. A bare ±HH is valid to Postgres but splits the two
// JavaScript date parsers: "…T12:00:00+00" is NaN under the strict ISO parser while
// "… 12:00:00+00" parses under the legacy one, so the same instant would be admitted or refused
// depending on the separator. Requiring the minutes keeps the admitted set one both agree on.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|z|[+-]\d{2}:\d{2})$/;
// Optional sign, then digits with an optional fractional part — either side of the point may be
// empty, as ".5" and "5." are both valid numerics to Postgres, but not both at once. Deliberately
// not Number(): 10^30 and 10^30+1 are distinct numerics that round to the same double, so
// comparing as numbers would report a match between two different values — the unsafe direction.
const DECIMAL = /^[+-]?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
// `int4in` is stricter than `numeric_in`: it takes digits and a sign, and rejects both a
// fractional part and an exponent. Accepting "1e2" for an int column here would match a row the
// read path cannot even ask about, because Postgres raises on the cast instead of comparing.
const INTEGER = /^[+-]?\d+$/;

// A canonical decimal: sign plus digits plus an exponent, with insignificant zeros removed, so
// that "100", "100.00", "1e2" and "+100" all reduce to the same string and nothing else does.
function canonicalDecimal(raw: string): string | null {
  const s = raw.trim();
  const m = DECIMAL.exec(s);
  if (!m) return null;
  const fracPart = m[2] ?? "";
  // Shift the decimal point out of existence: every value becomes an integer digit string
  // scaled by a power of ten.
  let digits = `${m[1] ?? ""}${fracPart}`;
  // Both sides of the point empty means there were no digits at all — "." or "" or just a sign,
  // none of which Postgres accepts either.
  if (digits === "") return null;
  let scale = (m[3] ? Number(m[3]) : 0) - fracPart.length;
  // Strip leading zeros, then trailing zeros (raising the scale to compensate), so the pair
  // (digits, scale) is unique per value.
  digits = digits.replace(/^0+/, "");
  if (digits === "") return "0"; // every spelling of zero, signed or not
  const trailing = /0+$/.exec(digits);
  if (trailing) { digits = digits.slice(0, -trailing[0].length); scale += trailing[0].length; }
  return `${s.startsWith("-") ? "-" : ""}${digits}e${scale}`;
}

// A `date` is a calendar day, not an instant. The driver parses one into a Date at *local*
// midnight, so the day has to be read back with the local accessors: toISOString() would name
// the previous day everywhere east of UTC.
function canonicalDate(v: unknown): string | null {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const p = (n: number, w = 2) => n.toString().padStart(w, "0");
    return `${p(v.getFullYear(), 4)}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  if (typeof v !== "string") return null;
  return DATE_ONLY.test(v.trim()) ? v.trim() : null;
}

function canonicalInstant(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : String(v.getTime());
  if (typeof v !== "string" || !ISO_WITH_ZONE.test(v.trim())) return null;
  const t = new Date(v.trim()).getTime();
  return Number.isNaN(t) ? null : String(t);
}

function canonicalBoolean(v: unknown): string | null {
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (TRUE_LITERALS.has(s)) return "true";
    if (FALSE_LITERALS.has(s)) return "false";
  }
  if (v === 1) return "true";
  if (v === 0) return "false";
  return null;
}

// Postgres compares uuids as 128-bit values, so case, hyphens and braces are all insignificant.
function canonicalUuid(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const hex = v.trim().toLowerCase().replace(/^\{/, "").replace(/\}$/, "").replace(/-/g, "");
  return UUID_HEX.test(hex) ? hex : null;
}

// `type` is the field's declared type; `undefined` means text (config/schema.ts defaults it).
//
// Returns null for anything that cannot be compared exactly, which covers two cases the callers
// treat alike: a value this module declines to interpret, and SQL NULL. Both match nothing —
// `col = NULL` is never true in SQL, not even against another NULL — so collapsing them is safe,
// and it keeps the return type a plain `string | null`.
export function canonicalize(type: FieldConfig["type"], v: unknown): string | null {
  if (v === null || v === undefined) return null;
  switch (type) {
    case "int":
      if (typeof v === "number")
        return Number.isSafeInteger(v) ? canonicalDecimal(v.toString()) : null;
      return typeof v === "string" && INTEGER.test(v.trim()) ? canonicalDecimal(v) : null;
    case "numeric":
      if (typeof v === "number")
        return Number.isFinite(v) ? canonicalDecimal(v.toString()) : null;
      return typeof v === "string" ? canonicalDecimal(v) : null;
    case "timestamptz": return canonicalInstant(v);
    case "date":        return canonicalDate(v);
    case "boolean":     return canonicalBoolean(v);
    case "uuid":        return canonicalUuid(v);
    // jsonb equality is structural — key order and duplicate keys are normalised by Postgres,
    // and numbers inside are compared as numerics. Nothing here can reproduce that, and the old
    // String() form matched every object against every other, so a json filter is refused.
    case "json":        return null;
    case "text":
    case undefined:
      // The driver renders a bound parameter for a text column with its own text form, which for
      // the scalars a filter can hold is JavaScript's.
      return typeof v === "object" ? null : String(v);
    default:            return null;
  }
}

export type FilterValidationError = { field: string; detail: string };

// Every predicate a grant carries, checked before either evaluator runs. Called by the read path
// (verbs/read.ts, where it already walks the same list to check field existence) and by the write
// path, so the two agree on which filters are evaluable at all.
//
// A null filter value is *not* an error: it is a legal predicate that matches nothing, which is
// what `col = NULL` does in SQL. Only a value whose type cannot be compared exactly is refused.
export function validateDocumentFilters(
  filters: DocumentFilter[], c: CollectionConfig,
): FilterValidationError | null {
  for (const f of filters) {
    const field = c.fields[f.field];
    if (!field) return { field: f.field, detail: "no such field on the collection" };
    // A view_join field is computed by the collection's view and is not stored on the base table
    // (apply/ddl.ts skips it), so the write path cannot see it at all. Allowing it on the read
    // path only would recreate exactly the divergence this module exists to remove.
    if (field.view_join)
      return { field: f.field, detail: "view_join fields are not stored on the base table" };
    const values = f.op === "in" && Array.isArray(f.value) ? f.value : [f.value];
    for (const v of values)
      if (v !== null && v !== undefined && canonicalize(field.type, v) === null)
        return { field: f.field, detail: `value is not a valid ${field.type ?? "text"}` };
  }
  return null;
}

// The grant's document filters, ANDed, evaluated against a row the write path already holds.
// `$self` is bound by loadActiveGrant, so by here every value is a plain literal. An empty list
// scopes nothing, which is what buildSelect does with it too.
//
// Callers must have run validateDocumentFilters first; an uninterpretable value reaching here
// matches nothing, so a skipped validation fails closed rather than open.
export function matchesFilters(
  row: Record<string, unknown>, filters: DocumentFilter[], c: CollectionConfig,
): boolean {
  return filters.every((f) => matchesFilter(row, f, c));
}

function matchesFilter(
  row: Record<string, unknown>, f: DocumentFilter, c: CollectionConfig,
): boolean {
  const type = c.fields[f.field]?.type;
  const actual = row[f.field];
  const wanted = f.op === "in" && Array.isArray(f.value) ? f.value : [f.value];
  // A field bound to a `multiple: true` vocabulary is a text[] column, which buildSelect matches
  // with `&&` / `= any`. Test for overlap here too, or the two evaluators disagree.
  const held = (Array.isArray(actual) ? actual : [actual]).map((a) => canonicalize(type, a));
  return wanted.some((v: unknown) => {
    const want = canonicalize(type, v);
    // null on either side is NULL or uninterpretable; neither can equal anything.
    return want !== null && held.some((a) => a !== null && a === want);
  });
}
