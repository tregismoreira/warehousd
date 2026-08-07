import {
  fileTableDDL,
  fileViewDDL,
  fileGrantImportDDL,
  fileGrantWriteDDL,
  fileDeclaredTables,
} from "../../apply/ddl";
import { FILE_RULES } from "../rules/file";
import type { CollectionKind } from "./types";

/**
 * A file collection: a directory of documents, indexed and chunked.
 *
 * Its identity is `path` and it declares no primary key — an ACL is keyed on document identity, so
 * `acl: true` is refused on one (config/rules/acl.ts). Its rows are chunks of a file, which is why
 * `getDocument` reassembles them and why the synthetic generator skips it: content comes from
 * `indexCollection`, not from a generator.
 */
export const fileKind: CollectionKind = {
  id: "file",
  rules: FILE_RULES,

  // A file collection is a record of what was INGESTED, so it only ever grows: `path` being
  // unique makes a repeat a conflict rather than a silent overwrite. Structural — no grant can
  // make a file revisable.
  supportedVerbs: (c) => (c.writable ? ["create"] : []),

  // `path` addresses the source file, `file_id` the ingested one. Both are broker-supplied, so
  // either may name a column outside allowedFields — `path` is commonly `posture: deny`.
  documentKey: (_c, intent) =>
    "path" in intent
      ? { field: "path", op: "eq", value: intent.path }
      : { field: "file_id", op: "eq", value: intent.id },

  // Always searchable: `{c}__documents.tsv` is generated from the chunked content, which is why
  // `searchable: true` on a field of one is refused as redundant.
  searchable: () => ({ mode: "tsv", fields: [] }),

  chunked: true,
  synthesisable: false,
  pkField: () => null,
  // `path` is unique per collection and is what a create names.
  identityField: () => "path",
  // And it is what an ACL is keyed on, for the same reason — see CollectionKind.aclKeyField for
  // why this is `path` and never `file_id`.
  aclKeyField: () => "path",

  ddl: {
    table: fileTableDDL,
    view: fileViewDDL,
    rlsTables: (schema, collection) => [
      `${schema}."${collection}__files"`,
      `${schema}."${collection}__documents"`,
    ],
    grantImport: fileGrantImportDDL,
    grantWrite: fileGrantWriteDDL,
    declaredTables: fileDeclaredTables,
  },
};
