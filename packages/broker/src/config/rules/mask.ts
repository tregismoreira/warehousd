import { MASK_TYPES, normalizePosture } from "../schema";
import type { CollectionRule, RawCollection } from "./types";

// Masking. Every rule here closes a way for a mask to be decorative rather than real.

// Whether a field's DECLARED read posture is `mask`, and whether it carries a transform. Both
// halves matter: a masked field without a transform is refused below rather than assumed, and the
// rules that follow only make sense once a transform is actually going to be applied.
function maskState(f: RawCollection["fields"][string]): { masked: boolean; hasMask: boolean } {
  return { masked: normalizePosture(f.posture).read === "mask", hasMask: !!f.mask };
}

export const maskRequiresTransform: CollectionRule = {
  id: "mask/requires-transform",
  check(c, ctx) {
    for (const [name, f] of Object.entries(c.fields)) {
      const { masked, hasMask } = maskState(f);
      if (masked && !hasMask)
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" has read: mask but no \`mask\` — declare the transform`,
        });
    }
  },
};

export const transformRequiresMaskPosture: CollectionRule = {
  id: "mask/transform-requires-mask-posture",
  check(c, ctx) {
    for (const [name, f] of Object.entries(c.fields)) {
      const p = normalizePosture(f.posture);
      if (p.read !== "mask" && f.mask)
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" declares \`mask\` but its read posture is "${p.read}"; a transform is only applied under read: mask`,
        });
    }
  },
};

// Read from the RAW posture, not the normalized one. normalizePosture deliberately pins unmask
// closed whenever read is not `mask`, so asking it here would make this branch unreachable and the
// typo would parse silently as "no unmask" — which is safe, but leaves the author believing they
// granted something they did not.
export const unmaskRequiresMaskPosture: CollectionRule = {
  id: "mask/unmask-requires-mask-posture",
  check(c, ctx) {
    for (const [name, f] of Object.entries(c.fields)) {
      const declared = f.posture;
      const declaredUnmask =
        typeof declared === "object" && declared !== null && "unmask" in declared
          ? (declared as { unmask?: unknown }).unmask
          : undefined;
      if (declaredUnmask === "allow" && normalizePosture(f.posture).read !== "mask")
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" has unmask: allow but is not masked; there is nothing to unmask`,
        });
    }
  },
};

// A pk addresses a document. getDocument round-trips it and every filter compares against it, so a
// masked one would return an id nothing can be looked up by.
export const pkNotMaskable: CollectionRule = {
  id: "mask/pk-not-maskable",
  check(c, ctx) {
    for (const [name, f] of Object.entries(c.fields)) {
      const { masked, hasMask } = maskState(f);
      if (!masked || !hasMask) continue;
      if (f.pk)
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" is the primary key and cannot be masked — it is how a document is addressed`,
        });
    }
  },
};

// The generated "<name>_tsv" column is built from the RAW column and is exposed by the view, so a
// masked searchable field would be fully recoverable one search at a time.
export const searchableNotMaskable: CollectionRule = {
  id: "mask/searchable-not-maskable",
  check(c, ctx) {
    for (const [name, f] of Object.entries(c.fields)) {
      const { masked, hasMask } = maskState(f);
      if (!masked || !hasMask) continue;
      if (f.searchable)
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" cannot be both searchable and masked — the generated ${name}_tsv column indexes the raw value`,
        });
    }
  },
};

export const fileContentPathNotMaskable: CollectionRule = {
  id: "mask/file-content-path-not-maskable",
  check(c, ctx) {
    if (c.type !== "file") return;
    for (const [name, f] of Object.entries(c.fields)) {
      const { masked, hasMask } = maskState(f);
      if (!masked || !hasMask) continue;
      if (name === "content" || name === "path")
        ctx.addIssue({
          code: "custom",
          message: `file field "${name}" cannot be masked (content is chunked and indexed; path addresses the file)`,
        });
    }
  },
};

// Which column types each transform can be computed over. `redact` and `hash` are absent from
// MASK_TYPES because they apply to anything: one replaces the value outright, the other casts to
// text first.
export const maskTransformType: CollectionRule = {
  id: "mask/transform-type",
  check(c, ctx) {
    for (const [name, f] of Object.entries(c.fields)) {
      const { masked, hasMask } = maskState(f);
      if (!masked || !hasMask || !f.mask) continue;
      const allowed = MASK_TYPES[f.mask.transform];
      if (allowed && f.type && !allowed.includes(f.type))
        ctx.addIssue({
          code: "custom",
          message: `field "${name}" has mask transform "${f.mask.transform}", which needs type ${allowed.join(" or ")}, but is type ${f.type}`,
        });
    }
  },
};

export const MASK_RULES: CollectionRule[] = [
  maskRequiresTransform,
  transformRequiresMaskPosture,
  unmaskRequiresMaskPosture,
  pkNotMaskable,
  searchableNotMaskable,
  fileContentPathNotMaskable,
  maskTransformType,
];
