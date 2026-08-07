import type { CollectionConfig, WarehousdConfig } from "../schema";
import type { Filter, GetDocumentIntent } from "../../types";
import type { CollectionRule } from "../rules/types";
import type { DeclaredTable } from "../../apply/ddl";

/**
 * What a KIND of collection is, as one object.
 *
 * `type: "dataset" | "file"` was branched on in 26 files — 40 `isFile` / `c.type === "file"` sites
 * in packages/broker alone, plus 13 more in apps/web — spread across the DDL, the config loader,
 * every read and write verb, the synthetic generator, the document inventory and import
 * validation. A third kind (a mailbox, a Drive mirror, a warehouse passthrough) meant finding all
 * forty and getting every one right, and the cost of missing one is not uniform: miss the branch
 * in `import/validate.ts` and you get a write path with no validation.
 *
 * So a kind is a registry entry, like `dbProviders` and `deploy/targets` already are. A fourth
 * kind is one file and one line in `kinds/index.ts`, and nothing outside this directory may branch
 * on a kind id.
 */
export type CollectionKind = {
  /** The `type:` value in warehousd.yml. */
  id: string;

  /**
   * Config rules that only apply to this kind. They are registered in COLLECTION_RULES like every
   * other rule and each guards on the type itself, so a rule read on its own is still true — see
   * config/rules/.
   */
  rules: CollectionRule[];

  /**
   * Which write verbs the kind can support at all, before any grant is consulted.
   *
   * Structural, not a preference: a file collection is a record of what was INGESTED and only ever
   * grows, so it supports `create` and nothing else. No grant can make a file revisable.
   */
  supportedVerbs(c: CollectionConfig): ("create" | "update" | "delete")[];

  /**
   * How `get_document` addresses one document, or null when the intent cannot address one.
   *
   * Broker-supplied rather than client-supplied, so it may reference a column outside
   * `allowedFields` — a file's `path` is commonly `posture: deny` and is exactly how you address
   * the file.
   */
  documentKey(c: CollectionConfig, intent: GetDocumentIntent): Filter | null;

  /**
   * How search matches, or null when the collection cannot be searched at all.
   *
   * `tsv` is one generated column over the chunked content; `fields` is a per-field set of
   * generated `<name>_tsv` columns. The distinction is why a dataset with no `searchable: true`
   * field refuses search while every file collection accepts it.
   */
  searchable(c: CollectionConfig): { mode: "tsv" | "fields"; fields: string[] } | null;

  /**
   * Whether a document of this kind is one row (a dataset) or many (a file's chunks).
   *
   * `getDocument` reassembles the chunks; the synthetic generator skips a kind it cannot generate.
   */
  chunked: boolean;

  /** Whether `generateSynthetic` can produce rows for this kind. */
  synthesisable: boolean;

  /** The declared primary key, or null for a kind that has no document identity of its own. */
  pkField(c: CollectionConfig): string | null;

  /**
   * The field that ADDRESSES a document rather than describing it.
   *
   * Exempt from the write posture on create, because a create has to be able to name what it is
   * creating — and requiring `write: allow` on it would say the opposite of what is true, namely
   * that identity may later be changed. On update and delete it is not accepted at all.
   */
  identityField(c: CollectionConfig): string | null;

  /** The kind's half of every DDL statement. See apply/ddl.ts for the shared halves. */
  ddl: KindDDL;
};

export type KindDDL = {
  table(env: Env, collection: string, cfg: WarehousdConfig): string;
  view(env: Env, collection: string, cfg: WarehousdConfig): string;
  /** The tables that carry the org-isolation policy. One for a dataset, two for a file. */
  rlsTables(schema: string, collection: string): string[];
  grantImport(collection: string, cfg: WarehousdConfig): string;
  grantWrite(schema: string, role: string, collection: string): string;
  declaredTables(collection: string, cfg: WarehousdConfig): DeclaredTable[];
};

export type Env = "dev" | "live";
