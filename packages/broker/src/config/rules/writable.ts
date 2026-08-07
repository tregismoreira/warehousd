import { writePosture } from "../schema";
import type { CollectionRule } from "./types";

// `writable: true` opens the write path for a collection. With no field carrying `write: allow`
// it opens a path every mutation is then refused on, which reads as a broken deployment rather
// than as the config saying nothing is writable.
export const writableRequiresWritableField: CollectionRule = {
  id: "writable/requires-writable-field",
  check(c, ctx) {
    if (!c.writable) return;
    if (!Object.values(c.fields).some((f) => writePosture(f) === "allow"))
      ctx.addIssue({
        code: "custom",
        message: `collection has writable: true but no field with write:allow`,
      });
  },
};

export const WRITABLE_RULES: CollectionRule[] = [writableRequiresWritableField];
