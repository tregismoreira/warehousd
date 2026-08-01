import { describe, it, expect } from "vitest";
import { redact, redactString } from "../src/log/redact";

describe("redact", () => {
  it("masks credential-bearing keys at any depth", () => {
    const out = redact({
      email: "a@b.com",
      password: "hunter2",
      nested: { access_token: "at_live_123", refresh_token: "rt_456", keep: "ok" },
      list: [{ client_secret: "cs_789" }],
    }) as Record<string, unknown>;

    expect(out.email).toBe("a@b.com");
    expect(out.password).toBe("[redacted]");
    const nested = out.nested as Record<string, unknown>;
    expect(nested.access_token).toBe("[redacted]");
    expect(nested.refresh_token).toBe("[redacted]");
    expect(nested.keep).toBe("ok");
    expect((out.list as Record<string, unknown>[])[0]?.client_secret).toBe("[redacted]");
  });

  // Defence in depth behind the broker's own field gating: an object that somehow escaped with a
  // denied field on it still must not carry the value into a log line.
  it("masks the field names the example config denies, leaving ordinary ones alone", () => {
    const out = redact({
      full_name: "P",
      home_address: "1 Main St",
      ssn: "000-00-0000",
      phone: "555",
    }) as Record<string, unknown>;

    expect(out.full_name).toBe("P");
    expect(out.home_address).toBe("[redacted]");
    expect(out.ssn).toBe("[redacted]");
    expect(out.phone).toBe("[redacted]");
  });

  it("does not mutate its input", () => {
    const input = { password: "hunter2", nested: { token: "t" } };
    redact(input);
    expect(input.password).toBe("hunter2");
    expect(input.nested.token).toBe("t");
  });

  it("survives a cycle rather than recursing forever", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
    expect((redact(a) as Record<string, unknown>).self).toBe("[circular]");
  });

  it("leaves primitives and null alone", () => {
    expect(redact(null)).toBeNull();
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
  });
});

describe("redactString", () => {
  it("masks the password in a connection string but keeps the rest legible", () => {
    const out = redactString("connect postgres://warehousd_live:swordfish@db:5432/wh");
    expect(out).not.toContain("swordfish");
    // Host, port and database are the reason anyone reads the line.
    expect(out).toContain("db:5432/wh");
    expect(out).toContain("warehousd_live");
  });

  // The trap packages/cli/src/ui/mask.ts documents: `new URL` parses `user:secret@host` as
  // scheme `user:` with no password at all, and hands the credential straight back.
  it("masks a bare user:secret@host with no scheme", () => {
    expect(redactString("warehousd_live:swordfish@db")).not.toContain("swordfish");
  });

  it("masks a bearer token", () => {
    const out = redactString("Authorization: Bearer eyJhbGciOi.abc.def");
    expect(out).not.toContain("eyJhbGciOi.abc.def");
    expect(out.toLowerCase()).toContain("bearer");
  });

  it("leaves a string with nothing sensitive in it untouched", () => {
    const plain = "select 3 documents from people";
    expect(redactString(plain)).toBe(plain);
  });
});
