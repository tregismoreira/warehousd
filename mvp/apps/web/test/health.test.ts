import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb } from "./helpers/web-db";

let db: Awaited<ReturnType<typeof setupWebDb>>;

beforeAll(async () => {
  db = await setupWebDb("health");
}, 60_000);

afterAll(async () => {
  await db?.end();
});

describe("health", () => {
  it("returns ok when database responds", async () => {
    const { GET } = await import("../app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
