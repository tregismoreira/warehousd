import { writePosture } from "../schema";
import type { CollectionRule } from "./types";

// A rule sees one collection, but a relation is about two. The other side comes from the config
// object the rule context carries; if `ctx` does not expose it, these checks move to
// ConfigSchema's own superRefine, which does see every collection. Check how
// config/rules/source-ref.ts reaches cross-collection information and follow it exactly.

export const relationTarget: CollectionRule = {
  id: "relation/target",
  check(c, ctx) {
    for (const [name, f] of Object.entries(c.fields)) {
      const rel = f.relation;
      if (!rel) continue;

      const on = c.fields[rel.on];
      if (!on) {
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" has a relation on unknown field "${rel.on}"`,
        });
        continue;
      }
      if (!on.fk) {
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" has a relation on field "${rel.on}", which does not have fk`,
        });
        continue;
      }
      if (!on.fk.startsWith(`${rel.collection}.`))
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" relates to collection "${rel.collection}" but field "${rel.on}" has fk: ${on.fk}`,
        });
      if (on.relation)
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" has a relation on field "${rel.on}", which is itself a relation; a relation reaches one collection, not a chain`,
        });
    }
  },
};

// A relation field has no column on the base table, so `write: allow` on one says a write can
// land somewhere it cannot. Identical in force to viewJoinWriteDeny, and stated separately
// because a reader looking up "why is my relation write-denied" should find this rule, not that
// one.
export const relationWriteDeny: CollectionRule = {
  id: "relation/write-deny",
  check(c, ctx) {
    for (const [name, f] of Object.entries(c.fields)) {
      if (!f.relation) continue;
      if (writePosture(f) === "allow")
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" has a relation and write: allow; relation fields are always write-deny`,
        });
    }
  },
};

// A relation replaces the field's own storage, so every key that describes a stored column is a
// contradiction rather than a redundancy.
export const relationExclusive: CollectionRule = {
  id: "relation/exclusive",
  check(c, ctx) {
    for (const [name, f] of Object.entries(c.fields)) {
      if (!f.relation) continue;
      for (const key of ["type", "pk", "fk", "view_join", "searchable"] as const) {
        if (f[key] !== undefined)
          ctx.addIssue({
            code: "custom",
            message: `field "${name}" has a relation and "${key}"; a relation field has no column of its own`,
          });
      }
    }
  },
};

export const RELATION_RULES: CollectionRule[] = [
  relationTarget,
  relationWriteDeny,
  relationExclusive,
];
