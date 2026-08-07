import { ACL_COLUMN } from "../schema";
import type { CollectionRule } from "./types";

// Every field name lands in a generated SQL identifier, so it is held to the identifier shape.
const FIELD_NAME = /^[a-z_][a-z0-9_]*$/i;

export const fieldNameShape: CollectionRule = {
  id: "field/name-shape",
  check(c, ctx) {
    for (const name of Object.keys(c.fields))
      if (!FIELD_NAME.test(name))
        ctx.addIssue({
          code: "custom",
          message: `field name "${name}" invalid (must match [a-z_][a-z0-9_]*)`,
        });
  },
};

// `_acl` is the view's ACL column. A field of that name would collide with it, and the collision
// would arrive as a duplicate-column error from `create view`, a long way from the line that caused
// it — and on a collection with `acl: false` it would quietly become a grantable field that the
// ACL evaluator then reads as a policy.
export const aclColumnReserved: CollectionRule = {
  id: "field/acl-reserved",
  check(c, ctx) {
    for (const name of Object.keys(c.fields))
      if (name === ACL_COLUMN)
        ctx.addIssue({
          code: "custom",
          message: `field name "${ACL_COLUMN}" is reserved — it is the per-document ACL column`,
        });
  },
};

export const FIELD_RULES: CollectionRule[] = [fieldNameShape, aclColumnReserved];
