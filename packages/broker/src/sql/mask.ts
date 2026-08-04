import type { MaskConfig } from "../config/schema";
import { ident } from "./ident";

// The SQL a masked field is selected as.
//
// Masking happens HERE, in the statement, and not in JavaScript after the rows come back. That is
// the whole design: the raw value is never fetched, so it cannot appear in a response, in an error
// body, in a log line, or in a heap dump — the same standard "denied means absent" sets for a
// denied field. A post-processing step would have all four of those exposures and would look
// identical in a passing test.
//
// Every transform is looked up in a closed record keyed by the literal, exactly as OP_SQL and
// AGG_SQL are in build.ts, and every parameter is bound. Nothing from the caller reaches this
// file at all: the transform and its arguments come from validated YAML.

export class UnsupportedMask extends Error {}

// The env var holding the HMAC key for `transform: hash`. Absent means the deployment has not
// configured one — see hashKey() for why that is a refusal rather than a default.
export const MASK_KEY_ENV = "WAREHOUSD_MASK_KEY";

/**
 * The key `transform: hash` is computed under. Deliberately has no fallback: a default key is a
 * public key, and `hash` exists to be a pseudonym that only this deployment can correlate. A
 * missing key throws, the read verb catches it as an internal_error, and the operator gets a log
 * line naming the variable — which is a better failure than silently issuing hashes that any
 * other warehousd install could reproduce.
 */
export function hashKey(): string {
  const k = process.env[MASK_KEY_ENV];
  if (!k)
    throw new UnsupportedMask(
      `${MASK_KEY_ENV} is not set; a field with mask transform "hash" cannot be read without it`,
    );
  return k;
}

/**
 * The select-list expression for one masked column, aliased back to the field's own name so the
 * result key is identical to the unmasked case. A caller cannot tell from the shape of the
 * response whether a field was masked — only `describeCollection` says so, on purpose.
 *
 * @param param binds a value and returns its placeholder — the same closure buildSelect uses, so
 * masking parameters share one numbering with filters and search terms.
 */
export function maskExpr(field: string, mask: MaskConfig, param: (v: unknown) => string): string {
  const c = ident(field);
  const alias = ident(field);
  let expr: string;

  switch (mask.transform) {
    case "redact":
      // A fixed token. Null stays null: "this document has no value here" is not a disclosure,
      // and collapsing it into the token would make every row look populated.
      expr = `'[redacted]'`;
      break;
    case "last4":
      // right() on a value shorter than four characters returns the whole thing, which would
      // reveal a short value entirely. Guard the length rather than trust the data.
      expr = `case when length(${c}::text) <= 4 then '••••' else '••••' || right(${c}::text, 4) end`;
      break;
    case "first":
      expr = `left(${c}::text, ${param(mask.chars)}::int) || '…'`;
      break;
    case "hash":
      // pgcrypto. Keyed, so the mapping cannot be reproduced outside this deployment, and
      // deterministic, so equal values stay equal — that is what makes a hashed column still
      // useful for grouping without being readable.
      expr = `encode(hmac(${c}::text, ${param(hashKey())}, 'sha256'), 'hex')`;
      break;
    case "bucket": {
      // floor() rather than round(): a band must never overlap its neighbour, and rounding puts
      // the boundary value in the higher band half the time.
      const w = param(mask.width);
      expr = `floor(${c}::numeric / ${w}::numeric) * ${w}::numeric`;
      break;
    }
    case "year":
      expr = `extract(year from ${c})::int`;
      break;
    case "domain":
      // Everything after the @. A value with no @ yields '', not the original — split_part
      // returns empty for a missing delimiter, which is the safe direction.
      expr = `split_part(${c}::text, '@', 2)`;
      break;
    default: {
      // Unreachable while MaskConfig and this switch agree; the assertion is what makes adding a
      // transform to the schema without adding it here a compile error rather than a silent
      // fall-through that selects the raw column.
      const never: never = mask;
      throw new UnsupportedMask(`unknown mask transform: ${JSON.stringify(never)}`);
    }
  }

  // Null in, null out, for every transform. Without this, `redact` labels an absent value as
  // present and `hash` invents a pseudonym for nothing.
  return `case when ${c} is null then null else ${expr} end as ${alias}`;
}
