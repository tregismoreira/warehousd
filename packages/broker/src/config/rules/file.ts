import { FILE_FIELDS, FILE_METADATA_TYPES } from "../schema";
import type { CollectionRule } from "./types";

// The rules that only apply to `type: file`. Each one guards on the type itself rather than being
// reached through a branch, so a rule stays true when read on its own — and so §D's CollectionKind
// registry can hand this list to the file kind without unpicking an if/else.

export const fileRequiresSource: CollectionRule = {
  id: "file/requires-source",
  check(c, ctx) {
    if (c.type !== "file") return;
    if (!c.source) ctx.addIssue({ code: "custom", message: "file collection requires `source`" });
  },
};

// A file collection's field set is FILE_FIELDS plus its bound vocabularies plus typed metadata.
// Anything else must declare a type from the metadata set — frontmatter is hand-written prose, so
// `uuid` and `json` are deliberately not in it.
export const fileMetadataFieldType: CollectionRule = {
  id: "file/metadata-field-type",
  check(c, ctx) {
    if (c.type !== "file") return;
    const fixed = new Set<string>(FILE_FIELDS as readonly string[]);
    const allowed = new Set<string>(FILE_METADATA_TYPES);
    for (const [k, f] of Object.entries(c.fields)) {
      if (fixed.has(k)) continue;
      if (c.taxonomies.includes(k)) continue;
      if (!f.type || !allowed.has(f.type))
        ctx.addIssue({
          code: "custom",
          message: `file collection field "${k}" must have type text/date/timestamptz/numeric/int/boolean (or be a FILE_FIELD or bound taxonomy)`,
        });
    }
  },
};

// Metadata describes a file; it does not address a document and it does not join. A file
// collection declares no primary key at all — its identity is `path`.
export const fileMetadataFieldConstraints: CollectionRule = {
  id: "file/metadata-field-constraints",
  check(c, ctx) {
    if (c.type !== "file") return;
    const fixed = new Set<string>(FILE_FIELDS as readonly string[]);
    for (const [k, f] of Object.entries(c.fields)) {
      if (fixed.has(k)) continue;
      if (c.taxonomies.includes(k)) continue;
      if (f.pk || f.fk || f.view_join)
        ctx.addIssue({
          code: "custom",
          message: `file metadata field "${k}" cannot have pk/fk/view_join`,
        });
    }
  },
};

export const FILE_RULES: CollectionRule[] = [
  fileRequiresSource,
  fileMetadataFieldType,
  fileMetadataFieldConstraints,
];
