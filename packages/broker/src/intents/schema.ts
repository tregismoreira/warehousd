import { z } from "zod";

// Runtime shapes for the four client-supplied intents. `types.ts` declares them as TypeScript
// types, which is a compile-time claim about code we wrote — it says nothing about a JSON body
// or an MCP tool argument. Everything in this file exists to make the claim true at runtime.
//
// Why it lives in the broker rather than in each adapter: the broker is the one place both the
// REST adapter and the MCP endpoint must pass through, and it is the layer that owns the
// promise in SECURITY.md — "client-supplied input reaching SQL other than as a bound
// parameter" is a vulnerability. An adapter that forgets to validate is a bug; an adapter that
// *cannot* forget is a design. Adapters parse too, so a malformed body answers 400 before it
// costs a grant lookup, but the broker never trusts that they did.
//
// Unknown keys are dropped, not rejected, and that is deliberate. "Any env-like value in the
// request body is ignored and never read" is a stated invariant (types.ts, broker-context.ts,
// session.ts) with a named acceptance test behind it — §10 test 5 forges `env: "live"` into tool
// arguments and requires the call to *succeed* against dev. "Ignored" is the stronger claim:
// it says no code path reads the value at all, where "refused" only says this one noticed.
// It also keeps the tool surface usable by the untrusted proposer the design is built around —
// a model that adds a stray key should be corrected by describe_collection, not hard-refused.
//
// The safety here comes from the enums and the identifier regexes below, not from strictness:
// `fn` and `op` are the only intent values that reach the SQL text as syntax, and a field name
// is only ever a quoted identifier drawn from a closed set.

// The identifier shape sql/build.ts's q() and broker.ts's ident() enforce. Checking it here as
// well means a bad identifier is a 400 naming the field rather than an internal_error: those
// quoting functions throw, and a throw is indistinguishable from a broker bug by design.
const IDENT = /^[a-z_][a-z0-9_]*$/i;
const Ident = z.string().regex(IDENT, "must match [a-z_][a-z0-9_]*");

// Deliberately unconstrained: a filter compares against real column values, which may be a
// string, a number, a boolean, a date literal or null. It is always a bound parameter, never
// interpolated, so its *shape* carries no injection risk — only its type does, and Postgres
// answers that. `in` additionally accepts an array, handled per-op below.
const FilterValue = z.unknown();

export const FILTER_OPS = ["eq", "neq", "gt", "lt", "gte", "lte", "like", "in"] as const;
export const AGGREGATE_FNS = ["avg", "sum", "count", "min", "max"] as const;

export const FilterSchema = z.object({
  field: Ident,
  op: z.enum(FILTER_OPS),
  value: FilterValue,
});

// `fn` is the one intent value that reaches the SQL text as an identifier rather than a
// parameter — buildSelect emits `<fn>(<field>)`. An enum here is what makes that safe, and
// sql/build.ts re-checks it against the same list rather than trusting this.
export const AggregateSchema = z.object({
  fn: z.enum(AGGREGATE_FNS),
  field: Ident,
});

// Type only, deliberately not bounds. `limit` is capped rather than refused — types.ts calls it
// "hard-capped server-side (default 100, max 500)" and buildSelect's Math.min/Math.max is that
// cap, with a probe suite asserting an oversized limit is *allowed* and clamped. Asking for
// 10,000 rows is a reasonable thing to do badly; the server decides how many it will hand over.
//
// What is refused is a `limit` that is not a number at all: `Math.max(1, "abc")` is NaN, so
// `limit: "abc"` produced `limit NaN`, which Postgres rejects — turning the caller's bad input
// into internal_error, reading as our fault rather than theirs. z.number() also rejects NaN, and
// .int() rejects Infinity and fractions, which Postgres would reject too.
const Limit = z.number().int();
const Offset = z.number().int();

export const QueryIntentSchema = z.object({
  collection: Ident,
  fields: z.array(Ident).optional(),
  filters: z.array(FilterSchema).optional(),
  orderBy: z.object({ field: Ident, dir: z.enum(["asc", "desc"]) }).optional(),
  limit: Limit.optional(),
  offset: Offset.optional(),
  aggregate: z.array(AggregateSchema).optional(),
  groupBy: z.array(Ident).optional(),
});

export const DocSearchIntentSchema = z.object({
  collection: Ident,
  q: z.string(),
  fields: z.array(Ident).optional(),
  limit: Limit.optional(),
  offset: Offset.optional(),
});

// id and path are mutually exclusive: they address different things (a dataset row by pk, a
// source file by path) and accepting both would leave the broker to pick, which is a decision
// the caller has to make.
export const GetDocumentIntentSchema = z.union([
  z.object({ collection: Ident, id: z.string() }),
  z.object({ collection: Ident, path: z.string() }),
]);

// Field NAMES are identifiers and are checked; field VALUES are bound parameters and are not.
// coerce() in import/validate.ts is what holds values to their declared type, per collection —
// this schema cannot know it.
const MutationValues = z.record(Ident, z.unknown());

export const MutationIntentSchema = z.discriminatedUnion("op", [
  z.object({ collection: Ident, op: z.literal("create"), values: MutationValues }),
  z.object({
    collection: Ident, op: z.literal("update"), id: z.string(),
    expect: z.string().optional(), values: MutationValues,
  }),
  z.object({
    collection: Ident, op: z.literal("delete"), id: z.string(), expect: z.string().optional(),
  }),
]);

// The verbs answer `invalid_intent` on a parse failure, and `invalid_intent` carries no detail
// by design — a refusal that quoted the offending value back would be the leak the reason code
// exists to avoid. The message is for the server log, not the caller.
export function describeIntentError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}
