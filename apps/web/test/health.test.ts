import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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

  // The 503 path is the whole point of this probe: `warehousd status` and Fly must not
  // see a healthy process when Postgres is unreachable. Both failure modes below are
  // driven by mocking the pool, since taking the real container down mid-suite would
  // break every other test file sharing it.
  it("returns 503 when the database query fails", async () => {
    vi.resetModules();
    vi.doMock("../app/lib/broker", () => ({
      getAppPool: () => ({ query: () => Promise.reject(new Error("ECONNREFUSED")) }),
    }));
    try {
      const { GET } = await import("../app/api/health/route");
      const res = await GET();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false });
    } finally {
      vi.doUnmock("../app/lib/broker");
      vi.resetModules();
    }
  });

  // getAppPool() builds the pools and parses the config on first call, so "Postgres is
  // gone" can surface as a throw from the accessor itself rather than from query().
  // That has to be a 503 too — it used to escape as an unhandled 500 with a stack.
  it("returns 503 when the pool cannot be constructed", async () => {
    vi.resetModules();
    vi.doMock("../app/lib/broker", () => ({
      getAppPool: () => {
        throw new Error("APP_DATABASE_URL is not set");
      },
    }));
    try {
      const { GET } = await import("../app/api/health/route");
      const res = await GET();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false });
    } finally {
      vi.doUnmock("../app/lib/broker");
      vi.resetModules();
    }
  });
});
