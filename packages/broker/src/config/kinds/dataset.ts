import {
  datasetTableDDL,
  datasetViewDDL,
  datasetGrantImportDDL,
  datasetGrantWriteDDL,
  datasetDeclaredTables,
} from "../../apply/ddl";
import { DATASET_RULES } from "../rules/dataset";
import { IMPORT_RULES } from "../rules/import";
import type { CollectionKind } from "./types";

/**
 * A dataset collection: rows, with a declared primary key and per-column postures.
 *
 * The default, and the destination for every spreadsheet import — a column can carry its own
 * posture, filter and aggregate, which is exactly what a file collection cannot do (one chunked,
 * embedded blob means one posture over the whole workbook).
 */
export const datasetKind: CollectionKind = {
  id: "dataset",
  rules: [...DATASET_RULES, ...IMPORT_RULES],

  supportedVerbs: (c) => (c.writable ? ["create", "update", "delete"] : []),

  // Addressed by the declared pk. Without one there is no document identity, so nothing can
  // address a document at all — the caller gets `invalid_intent` rather than a guess.
  documentKey: (c, intent) => {
    if (!("id" in intent)) return null;
    const pk = Object.entries(c.fields).find(([, f]) => f.pk)?.[0];
    return pk ? { field: pk, op: "eq", value: intent.id } : null;
  },

  // Only the fields that asked for it. A dataset with none cannot be searched, and refusing is
  // better than an empty result set that reads as "nothing matched".
  searchable: (c) => {
    const fields = Object.entries(c.fields)
      .filter(([, f]) => f.searchable === true)
      .map(([n]) => n);
    return fields.length ? { mode: "fields", fields } : null;
  },

  chunked: false,
  synthesisable: true,
  pkField: (c) => Object.entries(c.fields).find(([, f]) => f.pk)?.[0] ?? null,
  identityField: (c) => Object.entries(c.fields).find(([, f]) => f.pk)?.[0] ?? null,
  // A dataset's ACL is keyed on document identity, which is its declared pk. Without one there is
  // nothing to key on, and config refuses `acl: true`.
  aclKeyField: (c) => Object.entries(c.fields).find(([, f]) => f.pk)?.[0] ?? null,

  ddl: {
    table: datasetTableDDL,
    view: datasetViewDDL,
    rlsTables: (schema, collection) => [`${schema}.${collection}`],
    grantImport: datasetGrantImportDDL,
    grantWrite: datasetGrantWriteDDL,
    declaredTables: datasetDeclaredTables,
  },
};
