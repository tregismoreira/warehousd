import type { CollectionRule } from "./types";

// A dataset field becomes a real column, so it needs a declared type. The exceptions are a bound
// term field, whose type the transform fills in as text, and a relation field, which has no
// column of its own at all — relationExclusive refuses a relation from declaring `type`, so this
// rule must not turn around and require one.
export const datasetFieldRequiresType: CollectionRule = {
  id: "dataset/field-requires-type",
  check(c, ctx) {
    if (c.type === "file") return;
    const bound = new Set(c.taxonomies);
    for (const [k, f] of Object.entries(c.fields))
      if (!f.type && !bound.has(k) && !f.relation)
        ctx.addIssue({ code: "custom", message: `field "${k}" requires a type` });
  },
};

export const DATASET_RULES: CollectionRule[] = [datasetFieldRequiresType];
