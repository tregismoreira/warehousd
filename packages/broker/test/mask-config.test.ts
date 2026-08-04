import { describe, it, expect } from "vitest";
import {
  ConfigSchema,
  normalizePosture,
  readPosture,
  writePosture,
  unmaskPosture,
  isGrantable,
} from "../src/config/schema";
import { grantableFields, unmaskableFields, maskedFieldsFor } from "../src/config/load";

// Every refinement here closes a way for a mask to look applied and not be. The suite is written
// as "this config must not parse" rather than "this field must behave", because the point of
// doing it in the schema is that the bad config never reaches a database at all.

const base = (fields: Record<string, unknown>) => ({
  project: "t",
  server: { port: 1 },
  collections: { c: { description: "d", fields } },
});

const parse = (fields: Record<string, unknown>) => ConfigSchema.safeParse(base(fields));
const errorText = (fields: Record<string, unknown>) => {
  const r = parse(fields);
  if (r.success) throw new Error("expected the config to be refused, but it parsed");
  return r.error.issues.map((i) => i.message).join(" | ");
};

describe("mask config: what parses", () => {
  it("accepts a masked field with a matching transform", () => {
    const r = parse({
      id: { type: "uuid", posture: "allow", pk: true },
      ssn: { type: "text", posture: { read: "mask", write: "deny" }, mask: { transform: "last4" } },
    });
    expect(r.success).toBe(true);
  });

  it("accepts unmask: allow alongside a mask", () => {
    const r = parse({
      id: { type: "uuid", posture: "allow", pk: true },
      salary: {
        type: "numeric",
        posture: { read: "mask", write: "deny", unmask: "allow" },
        mask: { transform: "bucket", width: 25000 },
      },
    });
    expect(r.success).toBe(true);
  });

  it("defaults unmask to deny — declaring a mask does not offer the raw value to anyone", () => {
    const r = parse({
      id: { type: "uuid", posture: "allow", pk: true },
      ssn: { type: "text", posture: { read: "mask", write: "deny" }, mask: { transform: "last4" } },
    });
    if (!r.success) throw new Error("expected a parse");
    expect(unmaskPosture(r.data.collections.c!.fields.ssn!)).toBe("deny");
  });
});

describe("mask config: what is refused", () => {
  it("read: mask with no transform", () => {
    expect(errorText({ x: { type: "text", posture: { read: "mask", write: "deny" } } })).toMatch(
      /no `mask`/,
    );
  });

  it("a transform with no read: mask — the mask would silently never apply", () => {
    expect(
      errorText({ x: { type: "text", posture: "allow", mask: { transform: "last4" } } }),
    ).toMatch(/only applied under read: mask/);
  });

  it("unmask: allow on a field that is not masked", () => {
    expect(
      errorText({
        x: { type: "text", posture: { read: "allow", write: "deny", unmask: "allow" } },
      }),
    ).toMatch(/nothing to unmask/);
  });

  it("a masked primary key — identity has to round-trip", () => {
    expect(
      errorText({
        id: {
          type: "text",
          posture: { read: "mask", write: "deny" },
          pk: true,
          mask: { transform: "last4" },
        },
      }),
    ).toMatch(/primary key and cannot be masked/);
  });

  it("searchable + masked — the generated tsv column indexes the RAW value", () => {
    expect(
      errorText({
        id: { type: "uuid", posture: "allow", pk: true },
        body: {
          type: "text",
          posture: { read: "mask", write: "deny" },
          searchable: true,
          mask: { transform: "first", chars: 3 },
        },
      }),
    ).toMatch(/searchable and masked/);
  });

  it.each([
    ["bucket on text", { type: "text", transform: { transform: "bucket", width: 10 } }],
    ["year on numeric", { type: "numeric", transform: { transform: "year" } }],
    ["last4 on a date", { type: "date", transform: { transform: "last4" } }],
    ["domain on int", { type: "int", transform: { transform: "domain" } }],
    ["first on boolean", { type: "boolean", transform: { transform: "first", chars: 2 } }],
  ])("a transform its column type cannot compute: %s", (_label, spec) => {
    const s = spec as { type: string; transform: Record<string, unknown> };
    expect(
      errorText({
        id: { type: "uuid", posture: "allow", pk: true },
        x: { type: s.type, posture: { read: "mask", write: "deny" }, mask: s.transform },
      }),
    ).toMatch(/mask transform/);
  });

  it("an unknown transform", () => {
    const r = parse({
      id: { type: "uuid", posture: "allow", pk: true },
      x: { type: "text", posture: { read: "mask", write: "deny" }, mask: { transform: "rot13" } },
    });
    expect(r.success).toBe(false);
  });

  it("a transform missing its own parameter", () => {
    // `bucket` without a width and `first` without a length are config errors, not defaults.
    for (const mask of [{ transform: "bucket" }, { transform: "first" }]) {
      const r = parse({
        id: { type: "uuid", posture: "allow", pk: true },
        x: { type: "numeric", posture: { read: "mask", write: "deny" }, mask },
      });
      expect(r.success).toBe(false);
    }
  });

  it("a file collection's content or path", () => {
    const r = ConfigSchema.safeParse({
      project: "t",
      server: { port: 1 },
      collections: {
        docs: {
          description: "d",
          type: "file",
          source: "./x",
          fields: {
            title: { posture: "allow" },
            content: {
              posture: { read: "mask", write: "deny" },
              mask: { transform: "first", chars: 10 },
            },
          },
        },
      },
    });
    expect(r.success).toBe(false);
    if (r.success) throw new Error("unreachable");
    expect(r.error.issues.map((i) => i.message).join(" ")).toMatch(/cannot be masked/);
  });
});

describe("normalizePosture", () => {
  it("maps the bare forms", () => {
    expect(normalizePosture("allow")).toEqual({ read: "allow", write: "deny", unmask: "deny" });
    expect(normalizePosture("deny")).toEqual({ read: "deny", write: "deny", unmask: "deny" });
  });

  it("lands every unrecognised shape on deny/deny/deny", () => {
    for (const v of [undefined, null, 42, "MASK", {}, { read: "allow" }, { write: "allow" }])
      expect(normalizePosture(v)).toEqual({ read: "deny", write: "deny", unmask: "deny" });
  });

  it("refuses to carry unmask on a field that is not masked, even bypassing the schema", () => {
    // A posture that never went through CollectionSchema — a row edited by hand, a fixture built
    // in a test — still cannot arrive carrying an unmask nobody validated.
    expect(normalizePosture({ read: "allow", write: "deny", unmask: "allow" }).unmask).toBe("deny");
    expect(normalizePosture({ read: "mask", write: "deny", unmask: "allow" }).unmask).toBe("allow");
  });
});

describe("the field-set helpers agree about mask", () => {
  const cfg = ConfigSchema.parse(
    base({
      id: { type: "uuid", posture: "allow", pk: true },
      plain: { type: "text", posture: "allow" },
      secret: { type: "text", posture: "deny" },
      masked: {
        type: "text",
        posture: { read: "mask", write: "deny" },
        mask: { transform: "last4" },
      },
      maskedUnmaskable: {
        type: "text",
        posture: { read: "mask", write: "deny", unmask: "allow" },
        mask: { transform: "last4" },
      },
    }),
  );

  it("counts a masked field as grantable — mask is a disclosure level, not a refusal", () => {
    expect(grantableFields(cfg, "c").sort()).toEqual(
      ["id", "masked", "maskedUnmaskable", "plain"].sort(),
    );
    expect(isGrantable(cfg.collections.c!.fields.masked!)).toBe(true);
    expect(isGrantable(cfg.collections.c!.fields.secret!)).toBe(false);
  });

  it("offers only the fields whose posture says unmask: allow", () => {
    expect(unmaskableFields(cfg, "c")).toEqual(["maskedUnmaskable"]);
  });

  it("subtracts a grant's unmask list from the masked set", () => {
    expect(maskedFieldsFor(cfg, "c", []).sort()).toEqual(["masked", "maskedUnmaskable"]);
    expect(maskedFieldsFor(cfg, "c", ["maskedUnmaskable"])).toEqual(["masked"]);
  });

  it("keeps read and write axes independent of the mask", () => {
    const f = cfg.collections.c!.fields.masked!;
    expect(readPosture(f)).toBe("mask");
    expect(writePosture(f)).toBe("deny");
  });
});
