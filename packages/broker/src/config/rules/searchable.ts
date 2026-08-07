import type { CollectionRule } from "./types";

// A file collection already carries a tsv column on {c}__documents, built from the chunked
// content. Asking for a second one on a field says something that is already true.
export const searchableNotOnFile: CollectionRule = {
  id: "searchable/not-on-file",
  check(c, ctx) {
    if (c.type !== "file") return;
    for (const [name, f] of Object.entries(c.fields))
      if (f.searchable)
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" has searchable: true on a file collection; the {c}__documents.tsv column already exists, so it is redundant`,
        });
  },
};

export const searchableTextOnly: CollectionRule = {
  id: "searchable/text-only",
  check(c, ctx) {
    for (const [name, f] of Object.entries(c.fields))
      if (f.searchable && f.type !== "text")
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" has searchable: true but is not type text`,
        });
  },
};

// A searchable field generates a sibling "<name>_tsv" column. A declared field of that name would
// collide with it at DDL time, which is a confusing failure a long way from its cause.
export const searchableTsvCollision: CollectionRule = {
  id: "searchable/tsv-collision",
  check(c, ctx) {
    for (const [name, f] of Object.entries(c.fields))
      if (f.searchable && c.fields[`${name}_tsv`])
        ctx.addIssue({
          code: "custom",
          message: `field "${name}_tsv" collides with the generated search column for "${name}"`,
        });
  },
};

export const SEARCHABLE_RULES: CollectionRule[] = [
  searchableNotOnFile,
  searchableTextOnly,
  searchableTsvCollision,
];
