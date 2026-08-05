import { describe, it, expect, vi, beforeEach } from "vitest";

// One fake Pool per construction, so "was every pool this function opened also closed?" is a
// countable property rather than an argument about the code.
const opened: { url: string; ended: boolean }[] = [];
let answerAfter = 0;

vi.mock("pg", () => ({
  Pool: class {
    private readonly self: { url: string; ended: boolean };
    constructor(cfg: { connectionString: string }) {
      this.self = { url: cfg.connectionString, ended: false };
      opened.push(this.self);
    }
    query() {
      if (opened.length <= answerAfter) return Promise.reject(new Error("ECONNREFUSED"));
      return Promise.resolve({ rows: [{ "?column?": 1 }] });
    }
    end() {
      this.self.ended = true;
      return Promise.resolve();
    }
  },
}));

const { waitForPostgres } = await import("../scripts/wait-for-postgres");

describe("waitForPostgres", () => {
  beforeEach(() => {
    opened.length = 0;
    answerAfter = 0;
  });

  it("ends the pool of every failed attempt", async () => {
    // Three refusals, then Postgres comes up. The returned pool is the only one left open — a
    // version that ends nothing leaves four, which against a hosted url resuming from suspend is
    // a dangling socket per retry for the length of the wait.
    answerAfter = 3;
    const db = await waitForPostgres("postgres://x@h/d", 10_000);
    expect(opened).toHaveLength(4);
    expect(opened.filter((p) => !p.ended)).toHaveLength(1);
    expect(db).toBeDefined();
  }, 20_000);

  it("leaves nothing open when it gives up", async () => {
    answerAfter = Number.MAX_SAFE_INTEGER;
    await expect(waitForPostgres("postgres://x@h/d", 1_200)).rejects.toThrow(/Timeout waiting/);
    expect(opened.length).toBeGreaterThan(1);
    expect(opened.every((p) => p.ended)).toBe(true);
  });
});
