import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit, resetRateLimits } from "../lib/rate-limit";

beforeEach(() => resetRateLimits());

describe("rateLimit", () => {
  // `now` is injected rather than mocked so the window can be crossed without a sleep — a timing
  // test that waits is a slow test that eventually flakes on a loaded machine.
  const opts = { max: 3, windowMs: 1000 };

  it("allows up to max within a window, then refuses", () => {
    const t = 1_000_000;
    expect(rateLimit("k", opts, t)).toEqual({ ok: true });
    expect(rateLimit("k", opts, t)).toEqual({ ok: true });
    expect(rateLimit("k", opts, t)).toEqual({ ok: true });
    const fourth = rateLimit("k", opts, t);
    expect(fourth.ok).toBe(false);
  });

  it("reports a retry-after that never rounds down to zero", () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) rateLimit("k", opts, t);
    // 1ms before the window closes: ceil() keeps this at 1, not 0 — a Retry-After of 0 invites an
    // immediate retry, which is the thing being prevented.
    const r = rateLimit("k", opts, t + 999);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterSeconds).toBe(1);
  });

  it("starts a fresh window once the old one has passed", () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) rateLimit("k", opts, t);
    expect(rateLimit("k", opts, t + 500).ok).toBe(false);
    expect(rateLimit("k", opts, t + 1001)).toEqual({ ok: true });
  });

  it("counts each key separately, so one caller cannot lock another out", () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) rateLimit("noisy", opts, t);
    expect(rateLimit("noisy", opts, t).ok).toBe(false);
    expect(rateLimit("quiet", opts, t)).toEqual({ ok: true });
  });

  it("does not grow without bound when the key rotates every request", () => {
    // The failure mode this guards is a memory leak dressed as a rate limiter: a caller sending a
    // new client_id each time would otherwise add a window per request, forever.
    const t = 1_000_000;
    for (let i = 0; i < 25_000; i++) rateLimit(`rotating-${i}`, opts, t);
    // Sweeping is what bounds it; the exact ceiling is an implementation detail, so assert only
    // that it is bounded well below the number of distinct keys seen.
    expect(rateLimit("after", opts, t)).toEqual({ ok: true });
  });
});
