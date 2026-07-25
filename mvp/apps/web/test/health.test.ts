import { describe, it, expect } from "vitest";
describe("health", () => {
  it("returns ok", async () => {
    const { GET } = await import("../app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
