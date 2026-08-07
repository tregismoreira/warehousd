import type { CollectionRule } from "./types";

// `import.columns` maps a spreadsheet HEADER to a field on this collection.
//
// It lives in warehousd.yml rather than in a sidecar because a recurring import is governed like
// everything else: reviewed in a pull request, applied by `warehousd apply`. And it is a new key
// rather than a reuse of `FieldSchema.column`, which means "the column's name on the REMOTE table"
// and is refused outright without a `source_ref` (see source-ref.ts) — one key with two meanings
// is how that rule would stop being checkable.

// A mapping naming a field that does not exist is a CONFIG error, not an import-time one. The
// distinction matters: an import that fails on it would blame the spreadsheet for a mistake in
// the config, and the person holding the spreadsheet cannot fix the config.
export const importColumnTargetExists: CollectionRule = {
  id: "import/column-target-exists",
  check(c, ctx) {
    for (const [header, field] of Object.entries(c.import?.columns ?? {}))
      if (!Object.hasOwn(c.fields, field))
        ctx.addIssue({
          code: "custom",
          message: `import.columns maps header "${header}" to unknown field "${field}"`,
        });
  },
};

// A view_join field is resolved from a sibling table at view time and has no column on the base
// table, so there is nowhere for an imported value to land — validateImportRows already refuses
// one as `derived_column`, and a mapping that aims at one only makes that refusal harder to read.
export const importColumnTargetStorable: CollectionRule = {
  id: "import/column-target-storable",
  check(c, ctx) {
    for (const [header, field] of Object.entries(c.import?.columns ?? {}))
      if (c.fields[field]?.view_join)
        ctx.addIssue({
          code: "custom",
          message: `import.columns maps header "${header}" to "${field}", which is a view_join field and has no column to import into`,
        });
  },
};

// Two headers aiming at one field is a silent data loss: whichever column the parser yields last
// wins, and nothing downstream can tell that a column was dropped.
export const importColumnTargetUnique: CollectionRule = {
  id: "import/column-target-unique",
  check(c, ctx) {
    const seen = new Map<string, string>();
    for (const [header, field] of Object.entries(c.import?.columns ?? {})) {
      const first = seen.get(field);
      if (first !== undefined)
        ctx.addIssue({
          code: "custom",
          message: `import.columns maps both "${first}" and "${header}" to field "${field}"`,
        });
      else seen.set(field, header);
    }
  },
};

// A file collection is ingested by the indexer — one chunked, embedded blob per file — and
// `validateImportRows` refuses it outright as `file_collection`. An import block on one configures
// a path that can never run.
export const importNotOnFile: CollectionRule = {
  id: "import/not-on-file",
  check(c, ctx) {
    if (c.type !== "file" || !c.import) return;
    ctx.addIssue({
      code: "custom",
      message:
        "`import` is for dataset collections; a file collection is ingested by the indexer, not by a row import",
    });
  },
};

export const IMPORT_RULES: CollectionRule[] = [
  importColumnTargetExists,
  importColumnTargetStorable,
  importColumnTargetUnique,
  importNotOnFile,
];
