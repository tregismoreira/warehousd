import { describe, it, expect } from "vitest";
import { maskSecret, maskUrlPassword } from "../src/ui/mask";

describe("maskSecret", () => {
  it("keeps four characters at each end of a long secret", () => {
    expect(maskSecret("4215ee19af34169dc1cf6d2ffd3250a8e3748f4a2edc5a76feb62bd0908bdaf8")).toBe(
      "4215…daf8",
    );
  });

  it("hides a short value completely rather than leaking most of it", () => {
    expect(maskSecret("hunter2")).toBe("••••••••");
    expect(maskSecret("hunter2")).not.toContain("hunter");
  });

  it("falls back to ASCII when the terminal cannot do better", () => {
    expect(maskSecret("4215ee19af34169dc1cf6d2ffd3250a8", false)).toBe("4215...50a8");
    expect(maskSecret("short", false)).toBe("********");
  });

  it("returns empty for empty", () => {
    expect(maskSecret("")).toBe("");
  });

  // The property that matters: whatever the input, the original must not survive in the output.
  it.each([
    "a",
    "12345678901",
    "123456789012",
    "correct horse battery staple",
    "7ac704bfe39537f7a0898b2afd9d38715be7725bdf12996b",
  ])("never contains the whole input (%j)", (secret) => {
    const masked = maskSecret(secret);
    expect(masked).not.toBe(secret);
    expect(masked.includes(secret)).toBe(false);
  });
});

describe("maskUrlPassword", () => {
  it("masks only the password, keeping the parts a reader needs", () => {
    const url =
      "postgres://warehousd:7fc2e6dd2bde6a62a20668866334458a8e95e4bee341c97d@localhost:8723/warehousd";
    const masked = maskUrlPassword(url);
    expect(masked).not.toContain("7fc2e6dd2bde6a62a20668866334458a8e95e4bee341c97d");
    expect(masked).toContain("postgres://warehousd:");
    expect(masked).toContain("@localhost:8723/warehousd");
  });

  it("leaves a URL with no password alone", () => {
    const url = "postgres://localhost:5432/warehousd";
    expect(maskUrlPassword(url)).toBe(url);
  });

  it("leaves a non-URL without credentials alone", () => {
    expect(maskUrlPassword("not a url")).toBe("not a url");
  });

  // An unparseable string that still carries an @ could be a DSN holding a credential; masking
  // wholesale beats handing it back intact on the guess that it is safe.
  it("masks an unparseable string that looks like it carries a credential", () => {
    const masked = maskUrlPassword("user:supersecretvalue@host");
    expect(masked).not.toContain("supersecretvalue");
  });

  it("returns empty for empty", () => {
    expect(maskUrlPassword("")).toBe("");
  });
});
