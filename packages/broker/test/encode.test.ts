import { describe, it, expect } from "vitest";
import { encodeForColumn } from "../src/db/encode";

// Pure — no database. encodeForColumn is the one place a JS value becomes something
// node-postgres may bind to a declared column; see the reasoning on the function itself.
describe("encodeForColumn", () => {
  it("stringifies a json array", () => {
    expect(encodeForColumn("json", ["a", "b"])).toBe('["a","b"]');
  });

  it("stringifies a json object", () => {
    expect(encodeForColumn("json", { a: 1 })).toBe('{"a":1}');
  });

  it("stringifies a json value that is itself a string, without unwrapping it", () => {
    expect(encodeForColumn("json", "draft")).toBe('"draft"');
  });

  it("stringifies a json value that is itself a number", () => {
    expect(encodeForColumn("json", 123)).toBe("123");
  });

  it("passes null through as SQL NULL, never the jsonb document null", () => {
    expect(encodeForColumn("json", null)).toBe(null);
  });

  it("passes undefined through as SQL NULL", () => {
    expect(encodeForColumn("json", undefined)).toBe(null);
  });

  it("passes a non-json value through by reference, unmodified", () => {
    const d = new Date();
    expect(encodeForColumn("timestamptz", d)).toBe(d);
  });
});
