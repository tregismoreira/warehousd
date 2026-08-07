import type { CollectionRule } from "./types";

// A bound term field stores a slug, so it is text — or text[] when the vocabulary is
// `multiple: true`, which apply/ddl.ts derives rather than the author declaring.
export const taxonomyFieldType: CollectionRule = {
  id: "taxonomy/field-type",
  check(c, ctx) {
    for (const taxSlug of c.taxonomies) {
      const tf = c.fields[taxSlug];
      if (!tf) continue;
      if (tf.type && tf.type !== "text" && !tf.type.startsWith("text"))
        ctx.addIssue({
          code: "custom",
          message: `taxonomy field "${taxSlug}" must be type text`,
        });
    }
  },
};

// A term field describes a document; it does not address one and it does not reach a sibling
// table. All three of pk/fk/view_join would put a second meaning on a column the vocabulary owns.
export const taxonomyFieldConstraints: CollectionRule = {
  id: "taxonomy/field-constraints",
  check(c, ctx) {
    for (const taxSlug of c.taxonomies) {
      const tf = c.fields[taxSlug];
      if (!tf) continue;
      if (tf.pk || tf.fk || tf.view_join)
        ctx.addIssue({
          code: "custom",
          message: `taxonomy field "${taxSlug}" may not set pk/fk/view_join`,
        });
    }
  },
};

export const TAXONOMY_RULES: CollectionRule[] = [taxonomyFieldType, taxonomyFieldConstraints];
