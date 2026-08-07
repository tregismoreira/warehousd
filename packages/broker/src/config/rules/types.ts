import type { z } from "zod";
import type { RawCollection } from "../schema";

export type { RawCollection };

// One config rule about one collection.
//
// The registry exists because `CollectionSchema.superRefine` had grown into a 260-line callback
// holding a dozen unrelated rule clusters. Every cluster was individually correct; the problem was
// additive — a new collection capability meant editing a function nobody could review as a whole,
// and a rule could only be exercised through `ConfigSchema.parse` on an entire config.
//
// `id` is part of the contract, not a comment. It is what an issue carries as `params.rule`, so a
// config error can point at the rule that refused rather than only at a sentence, and it is what
// a per-rule unit test names. Renaming one changes a message a user may have searched for.
export type CollectionRule = {
  /** Stable anchor, "cluster/rule": "mask/pk-not-maskable", "acl/preconditions". */
  id: string;
  check: (c: RawCollection, ctx: z.RefinementCtx) => void;
};

// The whole set, applied in order. Split across modules by cluster so each file is one subject.
export function runCollectionRules(
  rules: readonly CollectionRule[],
  c: RawCollection,
  ctx: z.RefinementCtx,
): void {
  for (const rule of rules) rule.check(c, tag(ctx, rule.id));
}

// Stamp the rule's id onto every issue it raises.
//
// Done by wrapping the context once per rule rather than by asking each rule to remember: a rule
// that forgot would be indistinguishable from one with no anchor, which is the drift a stable id
// exists to prevent. A rule called directly from a unit test gets a plain ctx and behaves the same
// — the tag is metadata, never a condition.
function tag(ctx: z.RefinementCtx, rule: string): z.RefinementCtx {
  return {
    ...ctx,
    addIssue(arg) {
      if (typeof arg === "string") {
        ctx.addIssue({ code: "custom", message: arg, params: { rule } });
        return;
      }
      // No rule sets `params` itself, so there is nothing to merge — and overwriting rather than
      // merging is what keeps "the rule that raised this" a single unambiguous answer.
      ctx.addIssue({ ...arg, params: { rule } });
    },
  };
}
