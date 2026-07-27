import { describe, it, expect } from "vitest";
import { consoleEnabled } from "../lib/console-gate";

describe("consoleEnabled", () => {
  it("is on in development", () => {
    expect(consoleEnabled({ NODE_ENV: "development" })).toBe(true);
  });
  it("is on in production when demo mode is explicitly enabled", () => {
    expect(consoleEnabled({ NODE_ENV: "production", WAREHOUSD_DEMO: "true" })).toBe(true);
  });
  it("is off in production by default", () => {
    expect(consoleEnabled({ NODE_ENV: "production" })).toBe(false);
  });
  it("is off in production when demo mode is any value other than the literal 'true'", () => {
    expect(consoleEnabled({ NODE_ENV: "production", WAREHOUSD_DEMO: "1" })).toBe(false);
    expect(consoleEnabled({ NODE_ENV: "production", WAREHOUSD_DEMO: "yes" })).toBe(false);
  });
});
