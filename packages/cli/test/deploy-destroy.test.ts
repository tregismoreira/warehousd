import { describe, it, expect } from "vitest";
import { confirmDestroy } from "../src/deploy/destroy";

describe("confirmDestroy", () => {
  it("returns true for exact match", () => {
    expect(confirmDestroy("myapp", "myapp")).toBe(true);
  });

  it("returns false when typed string is wrong", () => {
    expect(confirmDestroy("otherapp", "myapp")).toBe(false);
  });

  it("returns false when typed string is empty", () => {
    expect(confirmDestroy("", "myapp")).toBe(false);
  });

  // An empty app name should be impossible (DeploySchema rejects it), which is exactly why this
  // is worth pinning: a bare equality check would make Enter-on-an-empty-prompt a confirmed
  // destroy the one time the impossible happens.
  it("returns false when both the typed value and the app name are empty", () => {
    expect(confirmDestroy("", "")).toBe(false);
  });

  it("returns false when typed has leading whitespace", () => {
    expect(confirmDestroy(" myapp", "myapp")).toBe(false);
  });

  it("returns false when typed has trailing whitespace", () => {
    expect(confirmDestroy("myapp ", "myapp")).toBe(false);
  });

  it("returns false when typed has surrounding whitespace", () => {
    expect(confirmDestroy(" myapp ", "myapp")).toBe(false);
  });

  it("returns false for case mismatch", () => {
    expect(confirmDestroy("MYAPP", "myapp")).toBe(false);
  });

  it("returns false for lowercase mismatch of uppercase name", () => {
    expect(confirmDestroy("myapp", "MYAPP")).toBe(false);
  });

  it("returns true for case match when both are uppercase", () => {
    expect(confirmDestroy("MYAPP", "MYAPP")).toBe(true);
  });

  it("returns true for case match with hyphens", () => {
    expect(confirmDestroy("my-app", "my-app")).toBe(true);
  });

  it("returns false for similar name", () => {
    expect(confirmDestroy("myapp1", "myapp")).toBe(false);
  });
});
