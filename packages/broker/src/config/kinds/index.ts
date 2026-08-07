import type { CollectionConfig } from "../schema";
import { COLLECTION_KIND_IDS, type CollectionKindId } from "./ids";
import type { CollectionKind } from "./types";
import { datasetKind } from "./dataset";
import { fileKind } from "./file";

/**
 * Every kind of collection warehousd knows about.
 *
 * A third kind — a mailbox, a Google Drive mirror, a warehouse passthrough — is one file and one
 * line here. Nothing else in the codebase may branch on a kind id: before this registry, `type`
 * was branched on in 26 files, and the cost of missing one was not uniform (miss the branch in
 * `import/validate.ts` and you get a write path with no validation).
 *
 * Same shape as `dbProviders` and `deploy/targets`, deliberately — three registries that behave
 * differently would be three things to learn.
 */
export const collectionKinds = {
  dataset: datasetKind,
  file: fileKind,
} satisfies Record<CollectionKindId, CollectionKind>;

// The id list lives in the leaf module `./ids` because the schema needs it at evaluation time;
// this is what stops the two drifting. Adding a kind means adding both, and forgetting the second
// fails here rather than as a config that parses and then has no rules.
{
  const registered = Object.keys(collectionKinds).sort().join(",");
  const declared = [...COLLECTION_KIND_IDS].sort().join(",");
  if (registered !== declared)
    throw new Error(
      `collection kind registry and COLLECTION_KIND_IDS disagree: [${registered}] vs [${declared}]`,
    );
}

export { COLLECTION_KIND_IDS, type CollectionKindId };

/**
 * The kind a collection is.
 *
 * `type` defaults to `dataset` in the schema, so an unknown value cannot arrive here from a parsed
 * config. A hand-built config object that skipped the schema still lands on `dataset`, which is
 * the value the schema would have given it.
 */
export function kindOf(c: Pick<CollectionConfig, "type">): CollectionKind {
  return collectionKinds[c.type] ?? datasetKind;
}

/**
 * Every kind-specific config rule, in registration order. Folded into `collectionRules()`.
 *
 * A getter rather than a const: `config/rules/index.ts` is on the other side of a cycle from this
 * module, and a const would be read before the registry above had been built.
 */
export function kindRules() {
  return Object.values(collectionKinds).flatMap((k) => k.rules);
}

export type { CollectionKind, KindDDL } from "./types";
