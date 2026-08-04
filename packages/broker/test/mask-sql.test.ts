import { describe, it, expect, afterEach } from "vitest";
import { maskExpr, UnsupportedMask, MASK_KEY_ENV } from "../src/sql/mask";
import { buildSelect } from "../src/sql/build";
import type { MaskConfig } from "../src/config/schema";

// The expression builder, on its own. The rule it exists to keep is that a mask parameter is
// BOUND, never interpolated — the same rule sql/build.ts keeps for filter values — so most of
// this file is "the number is in `values`, and is not in `text`".

const bind = () => {
  const values: unknown[] = [];
  const param = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  return { values, param };
};

const build = (field: string, mask: MaskConfig) => {
  const { values, param } = bind();
  return { sql: maskExpr(field, mask, param), values };
};

afterEach(() => {
  delete process.env[MASK_KEY_ENV];
});

describe("maskExpr", () => {
  it("aliases back to the field's own name so the result key is unchanged", () => {
    // A caller must not be able to tell a masked field from an unmasked one by the shape of the
    // response. describeCollection is the only place that says so.
    for (const mask of [
      { transform: "redact" },
      { transform: "last4" },
      { transform: "domain" },
    ] as MaskConfig[])
      expect(build("ssn", mask).sql).toMatch(/ as "ssn"$/);
  });

  it("returns null for a null input on every transform", () => {
    // Otherwise `redact` labels an absent value as present and `hash` invents a pseudonym for
    // nothing — both of which are disclosures about which rows are populated.
    const masks: MaskConfig[] = [
      { transform: "redact" },
      { transform: "last4" },
      { transform: "first", chars: 3 },
      { transform: "bucket", width: 10 },
      { transform: "year" },
      { transform: "domain" },
    ];
    for (const m of masks) expect(build("x", m).sql).toMatch(/^case when "x" is null then null/);
  });

  it("binds `first`'s length rather than interpolating it", () => {
    const { sql, values } = build("name", { transform: "first", chars: 3 });
    expect(values).toEqual([3]);
    expect(sql).toContain("$1");
    expect(sql).not.toMatch(/left\("name"::text, 3\)/);
  });

  it("binds `bucket`'s width once and reuses the placeholder", () => {
    const { sql, values } = build("salary", { transform: "bucket", width: 25000 });
    expect(values).toEqual([25000]);
    // One slot, used twice — divide and multiply — not two slots holding the same number.
    expect(sql.match(/\$1/g)).toHaveLength(2);
    expect(sql).not.toContain("25000");
  });

  it("floors rather than rounds, so bands never overlap", () => {
    expect(build("salary", { transform: "bucket", width: 10 }).sql).toContain("floor(");
  });

  it("does not reveal a short value through last4", () => {
    // right('abc', 4) is 'abc'. The length guard is what stops a three-character value coming
    // back whole under a mask that claims to show four characters.
    expect(build("x", { transform: "last4" }).sql).toContain("length(");
  });

  it("binds the hash key and never puts it in the statement text", () => {
    process.env[MASK_KEY_ENV] = "s3cret-key";
    const { sql, values } = build("email", { transform: "hash" });
    expect(values).toEqual(["s3cret-key"]);
    expect(sql).not.toContain("s3cret-key");
    expect(sql).toContain("hmac(");
  });

  it("refuses to hash without a configured key rather than defaulting to one", () => {
    // A default key is a public key: every warehousd install would produce the same pseudonyms,
    // which is exactly what `hash` exists not to do.
    expect(() => build("email", { transform: "hash" })).toThrow(UnsupportedMask);
    expect(() => build("email", { transform: "hash" })).toThrow(new RegExp(MASK_KEY_ENV));
  });

  it("throws on an unknown transform instead of falling through to the raw column", () => {
    expect(() => build("x", { transform: "rot13" } as unknown as MaskConfig)).toThrow(
      UnsupportedMask,
    );
  });

  it("quotes the field name", () => {
    // Field names are config-validated, but the builder keeps its own rule about them.
    expect(build("odd_name", { transform: "redact" }).sql).toContain(`"odd_name"`);
  });
});

describe("buildSelect applies masks in the select list", () => {
  const intent = { collection: "salaries", fields: ["id", "ssn"] };
  const maskFor = (f: string): MaskConfig | null => (f === "ssn" ? { transform: "last4" } : null);

  it("emits the transform for a masked column and the bare column for the rest", () => {
    const { text } = buildSelect("dev", intent, ["id", "ssn"], { maskFor });
    expect(text).toContain(`"id"`);
    expect(text).toMatch(/case when "ssn" is null/);
    // The raw column is never selected on its own.
    expect(text).not.toMatch(/select "id", "ssn"/);
  });

  it("is byte-identical to the unmasked build when nothing is masked", () => {
    const masked = buildSelect("dev", intent, ["id", "ssn"], { maskFor: () => null });
    const plain = buildSelect("dev", intent, ["id", "ssn"], {});
    expect(masked.text).toBe(plain.text);
    expect(masked.values).toEqual(plain.values);
  });

  it("numbers mask parameters in the same sequence as filter and search parameters", () => {
    const { text, values } = buildSelect(
      "dev",
      { collection: "c", fields: ["a", "b"], filters: [{ field: "a", op: "eq", value: "z" }] },
      ["a", "b"],
      { maskFor: (f) => (f === "b" ? { transform: "first", chars: 4 } : null) },
    );
    // The mask's parameter is bound first because the select list is built first.
    expect(values).toEqual([4, "z"]);
    expect(text).toContain("$1");
    expect(text).toContain("$2");
  });

  it("never masks an aggregate — those are refused upstream, not silently transformed", () => {
    // avg() of a bucketed column is a different number presented as an average, and min()/max()
    // would return the raw extremes. verbs/read.ts refuses before this point; the builder must
    // not quietly paper over a caller that skipped that check.
    const { text } = buildSelect(
      "dev",
      { collection: "salaries", aggregate: [{ fn: "avg", field: "base_salary" }] },
      ["base_salary"],
      { maskFor: () => ({ transform: "bucket", width: 1000 }) },
    );
    expect(text).toContain(`avg("base_salary")`);
    expect(text).not.toContain("floor(");
  });
});
