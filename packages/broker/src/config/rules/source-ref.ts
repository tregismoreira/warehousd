import type { CollectionRule } from "./types";

// Connect-in-place. A collection either stores its rows in warehousd or reads them from somewhere
// else; the two are different enough that mixing them is always a mistake.

export const sourceRefNotOnFile: CollectionRule = {
  id: "source-ref/not-on-file",
  check(c, ctx) {
    if (!c.source_ref) return;
    if (c.type === "file")
      ctx.addIssue({
        code: "custom",
        message:
          "`source_ref` is for dataset collections; a file collection is indexed from `source`",
      });
  },
};

export const sourceRefHasNoSourceDir: CollectionRule = {
  id: "source-ref/no-source-dir",
  check(c, ctx) {
    if (!c.source_ref) return;
    if (c.source || c.source_live)
      ctx.addIssue({
        code: "custom",
        message:
          "a collection with `source_ref` reads from an external database, so it has no `source` directory",
      });
  },
};

export const sourceRefNotWritable: CollectionRule = {
  id: "source-ref/not-writable",
  check(c, ctx) {
    if (!c.source_ref) return;
    if (c.writable)
      ctx.addIssue({
        code: "custom",
        message:
          "`writable: true` is not supported on a `source_ref` collection — warehousd reads external data, it does not write it",
      });
  },
};

// A join reaches a sibling table in the SAME schema. Resolving one across a foreign table would
// silently pull the whole remote relation over the wire per row.
export const sourceRefNoViewJoin: CollectionRule = {
  id: "source-ref/no-view-join",
  check(c, ctx) {
    if (!c.source_ref) return;
    for (const [name, f] of Object.entries(c.fields))
      if (f.view_join)
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" has view_join on an external collection; joins are not resolved across a source_ref`,
        });
  },
};

export const sourceRefNoSearchable: CollectionRule = {
  id: "source-ref/no-searchable",
  check(c, ctx) {
    if (!c.source_ref) return;
    for (const [name, f] of Object.entries(c.fields))
      if (f.searchable)
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" has searchable: true on an external collection; the generated tsv column would have to live on the remote table`,
        });
  },
};

// `column` means "the column's name on the REMOTE table". Without a `source_ref` there is no
// remote table, so the key renames nothing while reading as though it did.
//
// §P3's import mapping deliberately does NOT reuse this key: `import.columns` maps a spreadsheet
// header to a field, which is a different question with a different answer, and overloading one
// key with two meanings is how this rule stops being checkable.
export const columnRequiresSourceRef: CollectionRule = {
  id: "column/requires-source-ref",
  check(c, ctx) {
    if (c.source_ref) return;
    for (const [name, f] of Object.entries(c.fields))
      if (f.column)
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" declares \`column\` but the collection has no \`source_ref\`; there is no remote column to rename`,
        });
  },
};

export const SOURCE_REF_RULES: CollectionRule[] = [
  sourceRefNotOnFile,
  sourceRefHasNoSourceDir,
  sourceRefNotWritable,
  sourceRefNoViewJoin,
  sourceRefNoSearchable,
  columnRequiresSourceRef,
];
