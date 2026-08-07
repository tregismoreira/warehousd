/**
 * The kind ids, as a leaf module with no imports.
 *
 * `CollectionSchema` needs them at MODULE EVALUATION time — `z.enum` reads its members
 * immediately — and the registry cannot supply them there: a kind imports its own DDL, the DDL
 * imports `kindOf`, and the schema imports the rules, so the value would be read mid-cycle and
 * arrive undefined. Everything else about a kind stays in the registry; only the id list lives
 * here, and `kinds/index.ts` asserts the two agree.
 */
export const COLLECTION_KIND_IDS = ["dataset", "file"] as const;
export type CollectionKindId = (typeof COLLECTION_KIND_IDS)[number];
