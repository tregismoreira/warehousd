import type { CollectionRule } from "./types";
import { FIELD_RULES } from "./fields";
import { TAXONOMY_RULES } from "./taxonomy";
import { VIEW_JOIN_RULES } from "./view-join";
import { RELATION_RULES } from "./relation";
import { SEARCHABLE_RULES } from "./searchable";
import { WRITABLE_RULES } from "./writable";
import { ACL_RULES } from "./acl";
import { SOURCE_REF_RULES } from "./source-ref";
import { MASK_RULES } from "./mask";
import { INDEX_RULES } from "./indexes";
// Kind-specific rules come from the kind registry rather than from a second list here, so a new
// kind cannot arrive with rules that nothing runs. See config/kinds/.
import { kindRules } from "../kinds";

/**
 * Every rule `CollectionSchema` checks, in the order it checks them.
 *
 * A new collection capability is a new file and one line here — the same shape `dbProviders` and
 * `deploy/targets` already use. Nothing outside this module may hand-write a collection rule, and
 * `CollectionSchema.superRefine` does nothing but walk this list.
 *
 * The order is the order the issues come back in. It is not load-bearing for correctness — a
 * config with two problems has two problems — but it is what a reader sees first, so the cheap
 * structural rules (is this even a field name?) come before the semantic ones.
 */
/**
 * Built on first use, not at module evaluation.
 *
 * The kind registry imports each kind, each kind imports its own rules, and this module imports
 * the registry — a cycle. It is a safe one because every crossing is read from inside a function
 * body (the rules run when a config is parsed), and this list is the one thing that would have
 * been read at evaluation time. Memoised, so the cost is paid once.
 */
let cached: CollectionRule[] | null = null;

export function collectionRules(): CollectionRule[] {
  if (cached) return cached;
  const rules = [
    ...FIELD_RULES,
    ...TAXONOMY_RULES,
    ...VIEW_JOIN_RULES,
    ...RELATION_RULES,
    ...kindRules(),
    ...SEARCHABLE_RULES,
    ...INDEX_RULES,
    ...WRITABLE_RULES,
    ...ACL_RULES,
    ...SOURCE_REF_RULES,
    ...MASK_RULES,
  ];
  // Two ids naming different rules would make `params.rule` ambiguous, and a duplicated id is
  // exactly what a copy-pasted rule file produces.
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) throw new Error(`duplicate collection rule id "${r.id}"`);
    seen.add(r.id);
  }
  cached = rules;
  return cached;
}

export type { CollectionRule, RawCollection } from "./types";
export { runCollectionRules } from "./types";
export { FIELD_RULES } from "./fields";
export { TAXONOMY_RULES } from "./taxonomy";
export { VIEW_JOIN_RULES } from "./view-join";
export { RELATION_RULES } from "./relation";
export { FILE_RULES } from "./file";
export { DATASET_RULES } from "./dataset";
export { SEARCHABLE_RULES } from "./searchable";
export { WRITABLE_RULES } from "./writable";
export { ACL_RULES } from "./acl";
export { SOURCE_REF_RULES } from "./source-ref";
export { IMPORT_RULES } from "./import";
export { MASK_RULES } from "./mask";
export { INDEX_RULES } from "./indexes";
