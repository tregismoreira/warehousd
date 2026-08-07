import type { CollectionRule } from "./types";

// A dataset field becomes a real column, so it needs a declared type. The exception is a bound
// term field, whose type the transform fills in as text.
export const datasetFieldRequiresType: CollectionRule = {
  id: "dataset/field-requires-type",
  check(c, ctx) {
    if (c.type === "file") return;
    const bound = new Set(c.taxonomies);
    for (const [k, f] of Object.entries(c.fields))
      if (!f.type && !bound.has(k))
        ctx.addIssue({ code: "custom", message: `field "${k}" requires a type` });
  },
};

export const DATASET_RULES: CollectionRule[] = [datasetFieldRequiresType];
