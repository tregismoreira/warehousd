import { writePosture } from "../schema";
import type { CollectionRule } from "./types";

// `on` must name a field carrying `fk: <table>.<column>` for the same table the join reaches.
// Resolved here rather than at apply time, where the failure is a broken SQL join a long way from
// the two lines that disagreed.
export const viewJoinTarget: CollectionRule = {
  id: "view-join/target-field",
  check(c, ctx) {
    for (const [name, f] of Object.entries(c.fields)) {
      if (!f.view_join) continue;
      const fkFieldName = f.view_join.on;
      const fkField = c.fields[fkFieldName];
      if (!fkField)
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" view_join references unknown field "${fkFieldName}"`,
        });
      else if (!fkField.fk)
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" view_join references field "${fkFieldName}" which does not have fk`,
        });
      else if (!fkField.fk.startsWith(`${f.view_join.table}.`))
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" view_join references table "${f.view_join.table}" but field "${fkFieldName}" has fk: ${fkField.fk}`,
        });
    }
  },
};

// A view_join field has no column on the base table — it is resolved from a sibling at view time —
// so there is nothing for a write to land in. `write: allow` on one says otherwise.
export const viewJoinWriteDeny: CollectionRule = {
  id: "view-join/write-deny",
  check(c, ctx) {
    for (const [name, f] of Object.entries(c.fields)) {
      if (!f.view_join) continue;
      if (writePosture(f) === "allow")
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" has view_join and write: allow; view_join fields are always write-deny`,
        });
    }
  },
};

export const VIEW_JOIN_RULES: CollectionRule[] = [viewJoinTarget, viewJoinWriteDeny];
