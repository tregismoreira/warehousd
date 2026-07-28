import { describe, it, expect } from "vitest";

describe("deriveRestContext (unit tests)", () => {
  it("exports deriveRestContext as a function", async () => {
    const mod = await import("../lib/rest-context");
    expect(typeof mod.deriveRestContext).toBe("function");
  });

  it("function signature matches BrokerContext constructor pattern", async () => {
    const { deriveRestContext } = await import("../lib/rest-context");
    // Verify it's async and takes a Request
    expect(deriveRestContext.constructor.name).toBe("AsyncFunction");
    expect(deriveRestContext.length).toBe(1);
  });
});
