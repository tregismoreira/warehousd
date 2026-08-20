import { indexName, MAX_IDENTIFIER_BYTES } from "../collection";
import type { CollectionRule } from "./types";

// Indexes are a dataset concept. A file collection's searchable surface is its generated `tsv`
// and `embedding` columns, both emitted unconditionally by the DDL; there is no declared field on
// `<c>__documents` for an operator to index.
export const indexesDatasetOnly: CollectionRule = {
  id: "indexes/dataset-only",
  check(c, ctx) {
    if (!c.indexes?.length) return;
    if (c.type !== "dataset")
      ctx.addIssue({
        code: "custom",
        message: `collection declares indexes but has type "${c.type}"; indexes are supported on dataset collections only`,
      });
  },
};

// What can be indexed is what is STORED. A view_join or relation field is resolved at read time
// and has no column on the base table; a json field has no useful btree ordering.
export const indexesIndexableField: CollectionRule = {
  id: "indexes/indexable-field",
  check(c, ctx) {
    for (const idx of c.indexes ?? []) {
      for (const name of idx.fields) {
        const f = c.fields[name];
        if (!f) {
          ctx.addIssue({ code: "custom", message: `index names unknown field "${name}"` });
          continue;
        }
        if (f.view_join)
          ctx.addIssue({
            code: "custom",
            message: `index names field "${name}", which is not stored: a view_join field is resolved at read time`,
          });
        if (f.type === "json")
          ctx.addIssue({
            code: "custom",
            message: `index names field "${name}", which has type json; declare an index over a scalar field instead`,
          });
      }
    }
  },
};

// A duplicate is always a mistake and never a preference: within one index it is a typo, and
// across two it produces the same generated name twice, which `create index if not exists` would
// silently collapse into one.
export const indexesNoDuplicates: CollectionRule = {
  id: "indexes/no-duplicates",
  check(c, ctx) {
    const seen = new Set<string>();
    for (const idx of c.indexes ?? []) {
      const within = new Set<string>();
      for (const name of idx.fields) {
        if (within.has(name))
          ctx.addIssue({ code: "custom", message: `index names "${name}" twice` });
        within.add(name);
      }
      const key = idx.fields.join(",");
      if (seen.has(key))
        ctx.addIssue({
          code: "custom",
          message: `index over [${key}] is declared twice`,
        });
      seen.add(key);
    }
  },
};

// Postgres truncates past 63 bytes, so two long declarations that differ only in their tail would
// generate one index and the planner would then see a declared index that never appears. Refusing
// here turns that into a config error naming the entry.
export const indexesNameLength: CollectionRule = {
  id: "indexes/name-length",
  check(c, ctx) {
    for (const idx of c.indexes ?? []) {
      // The collection name is not known to a rule, so measure the field half plus the fixed
      // `_ix_` infix against a budget that leaves room for the longest collection name the
      // config allows. Using the real name would make the same index legal in one collection and
      // illegal in another, which is a worse error to explain.
      const generated = indexName("c".repeat(30), idx.fields);
      if (Buffer.byteLength(generated, "utf8") > MAX_IDENTIFIER_BYTES)
        ctx.addIssue({
          code: "custom",
          message: `index over [${idx.fields.join(",")}] generates a name that is too long for Postgres; use fewer or shorter fields`,
        });
    }
  },
};

export const INDEX_RULES: CollectionRule[] = [
  indexesDatasetOnly,
  indexesIndexableField,
  indexesNoDuplicates,
  indexesNameLength,
];
