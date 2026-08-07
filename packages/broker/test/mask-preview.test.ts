import { describe, it, expect } from "vitest";
import { maskPreview, maskSample } from "../src/sql/mask-preview";
import { MaskSchema } from "../src/config/schema";

// §P5's approve-sheet half. A manager ticking "show the real value" was choosing between two
// words with no way to see what the masked form gives a grant holder.
//
// The one property that makes this renderable to an approver who holds no grant on the field:
// the input is MADE UP. Nothing here reads a collection, a pool or an environment variable, and
// the whole module is synchronous — which is also what lets this file assert the entire table of
// transforms without provisioning anything.

const parse = (m: unknown) => MaskSchema.parse(m);

describe("every transform previews", () => {
  it("redact replaces the value outright", () => {
    expect(maskPreview("ssn", "text", parse({ transform: "redact" })).masked).toBe("[redacted]");
  });

  it("last4 keeps four characters behind bullets", () => {
    const p = maskPreview("bank_account", "text", parse({ transform: "last4" }));
    expect(p.masked).toBe(`••••${p.sample.slice(-4)}`);
    expect(p.masked).not.toContain(p.sample.slice(0, -4));
  });

  it("last4 withholds a short value entirely, matching the SQL's length guard", () => {
    // right() on a value of four characters or fewer returns the whole thing. Asserted over a
    // chosen input, because the generator has no reason to produce one that short.
    expect(maskSample("1234", parse({ transform: "last4" }))).toBe("••••");
    expect(maskSample("7", parse({ transform: "last4" }))).toBe("••••");
    expect(maskSample("12345", parse({ transform: "last4" }))).toBe("••••2345");
  });

  it("bucket floors the boundary value into the lower band, never the higher", () => {
    // round() would put 100_000 in the 100_000 band half the time and the 75_000 band the other
    // half. The SQL floors; so does this.
    expect(maskSample("99999", parse({ transform: "bucket", width: 25000 }))).toBe("75000");
    expect(maskSample("100000", parse({ transform: "bucket", width: 25000 }))).toBe("100000");
  });

  it("domain yields nothing rather than the original when there is no @", () => {
    expect(maskSample("not-an-address", parse({ transform: "domain" }))).toBe("");
  });

  it("first keeps the declared prefix", () => {
    const p = maskPreview("full_name", "text", parse({ transform: "first", chars: 3 }));
    expect(p.masked).toBe(`${p.sample.slice(0, 3)}…`);
  });

  it("hash is a stable hex digest of the right width", () => {
    const a = maskPreview("email", "text", parse({ transform: "hash" }));
    const b = maskPreview("email", "text", parse({ transform: "hash" }));
    expect(a.masked).toMatch(/^[0-9a-f]{64}$/);
    expect(a.masked).toBe(b.masked);
  });

  it("bucket floors into bands, never rounding into the neighbour", () => {
    const p = maskPreview("base_salary", "numeric", parse({ transform: "bucket", width: 25000 }));
    const n = Number(p.sample);
    expect(Number(p.masked)).toBe(Math.floor(n / 25000) * 25000);
    expect(Number(p.masked)).toBeLessThanOrEqual(n);
  });

  it("year keeps the year alone", () => {
    const p = maskPreview("hire_date", "date", parse({ transform: "year" }));
    expect(p.masked).toBe(p.sample.slice(0, 4));
  });

  it("domain keeps what is after the @", () => {
    const p = maskPreview("email", "text", parse({ transform: "domain" }));
    expect(p.sample).toContain("@");
    expect(p.masked).toBe(p.sample.split("@")[1]);
    expect(p.masked).not.toContain(p.sample.split("@")[0]);
  });
});

describe("the sample is generated, not stored", () => {
  it("is reproducible for a field, so the approve sheet does not flicker", () => {
    const a = maskPreview("base_salary", "numeric", parse({ transform: "bucket", width: 1000 }));
    const b = maskPreview("base_salary", "numeric", parse({ transform: "bucket", width: 1000 }));
    expect(a).toEqual(b);
  });

  it("differs between fields, so two rows do not read as one value", () => {
    const a = maskPreview("full_name", "text", parse({ transform: "first", chars: 3 }));
    const b = maskPreview("owner", "text", parse({ transform: "first", chars: 3 }));
    expect(a.sample).not.toBe(b.sample);
  });

  it("needs no mask key — the deployment without one is where a preview matters most", () => {
    const saved = process.env.WAREHOUSD_MASK_KEY;
    delete process.env.WAREHOUSD_MASK_KEY;
    try {
      expect(() => maskPreview("ssn", "text", parse({ transform: "hash" }))).not.toThrow();
    } finally {
      if (saved !== undefined) process.env.WAREHOUSD_MASK_KEY = saved;
    }
  });

  it("does not use the deployment's hash key, so a preview is not a real pseudonym", () => {
    const saved = process.env.WAREHOUSD_MASK_KEY;
    process.env.WAREHOUSD_MASK_KEY = "a-real-key";
    const withKey = maskPreview("ssn", "text", parse({ transform: "hash" })).masked;
    process.env.WAREHOUSD_MASK_KEY = "a-completely-different-key";
    const withOther = maskPreview("ssn", "text", parse({ transform: "hash" })).masked;
    if (saved === undefined) delete process.env.WAREHOUSD_MASK_KEY;
    else process.env.WAREHOUSD_MASK_KEY = saved;
    expect(withKey).toBe(withOther);
  });
});
