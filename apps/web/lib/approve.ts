import { findCollection, grantableFields, type WarehousdConfig } from "@warehousd/broker";

export type ApproveOpts = {
  allowedFields?: string[];
  expiresAt?: string;
  documentFilters?: { field: string; op: "in"; value: string[] }[];
};

export type ApprovalInput = {
  collection: string;
  allowedFields?: unknown;
  expiresAt?: unknown;
  selectedPaths?: unknown;
  selectedTerms?: unknown;
};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

// Turns an approver's form submission into approveGrant options, or a reason code.
//
// The document_filter FIELD is derived from the YAML config, never from the request: the
// approver picks values (which paths, which terms), the server decides which column those
// values gate. A forged `documentFilter` in the body is ignored outright — §5.6.4 requires
// the predicate to be author-supplied, and "author" here means this function.
export function buildApproval(
  cfg: WarehousdConfig,
  requestedFields: string[],
  input: ApprovalInput,
): { ok: true; opts: ApproveOpts } | { ok: false; error: string } {
  const c = findCollection(cfg, input.collection);
  if (!c) return { ok: false, error: "unknown_collection" };

  const grantable = grantableFields(cfg, input.collection);
  const approved = strings(input.allowedFields);
  if (approved.length === 0) return { ok: false, error: "no_fields" };
  for (const f of approved) {
    if (!grantable.includes(f)) return { ok: false, error: "field_not_grantable" };
    // An approver trims, never widens. Widening would let a manager hand out access the
    // requester never asked for and never stated a purpose for.
    if (!requestedFields.includes(f)) return { ok: false, error: "cannot_widen" };
  }

  const opts: ApproveOpts = { allowedFields: approved };

  if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== "") {
    if (typeof input.expiresAt !== "string") return { ok: false, error: "invalid_expiry" };
    const t = Date.parse(input.expiresAt);
    if (Number.isNaN(t)) return { ok: false, error: "invalid_expiry" };
    if (t <= Date.now()) return { ok: false, error: "expiry_in_past" };
    opts.expiresAt = new Date(t).toISOString();
  }

  // Build array of predicates: one per scoped vocabulary, plus path if specified.
  // Vocabularies and paths can coexist now.
  const selectedTermsMap =
    typeof input.selectedTerms === "object" && input.selectedTerms !== null
      ? (input.selectedTerms as Record<string, unknown>)
      : {};
  const paths = strings(input.selectedPaths);
  const filters: { field: string; op: "in"; value: string[] }[] = [];

  // Emit one predicate per vocabulary with selected terms
  for (const vocabSlug of c.taxonomies ?? []) {
    const vocabTerms = strings(selectedTermsMap[vocabSlug]);
    if (vocabTerms.length > 0) {
      filters.push({ field: vocabSlug, op: "in", value: vocabTerms });
    }
  }

  // Emit path predicate if specified
  if (paths.length > 0 && c.type === "file") {
    filters.push({ field: "path", op: "in", value: paths });
  }

  if (filters.length > 0) {
    opts.documentFilters = filters;
  }

  return { ok: true, opts };
}
