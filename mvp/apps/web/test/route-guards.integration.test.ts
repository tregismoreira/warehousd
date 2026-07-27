import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupWebDb, signIn } from "./helpers/web-db";

let db: Awaited<ReturnType<typeof setupWebDb>>;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  db = await setupWebDb("guards");
  cookies.mia = await signIn(db.auth, "mia@meridian.demo", "demo");
  cookies.marcus = await signIn(db.auth, "marcus@meridian.demo", "demo");
  cookies.ana = await signIn(db.auth, "ana@meridian.demo", "demo");
}, 60_000);
afterAll(async () => { await db?.end(); });

function req(cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  return new Request("http://localhost:8722/x", { headers });
}

// (actor, surface) → expected outcome. Kept as data so later tasks add rows, not code.
const MATRIX: [keyof typeof cookies, "admin" | "manager" | "member", boolean][] = [
  ["mia", "member", true],   ["mia", "manager", false],   ["mia", "admin", false],
  ["marcus", "member", true], ["marcus", "manager", true], ["marcus", "admin", false],
  ["ana", "member", true],   ["ana", "manager", true],    ["ana", "admin", true],
];

describe("surface authorization matrix", () => {
  for (const [who, surface, allowed] of MATRIX) {
    it(`${who} ${allowed ? "may" : "may not"} reach a ${surface}-gated route`, async () => {
      const { requireRole } = await import("../lib/authz");
      const r = await requireRole(req(cookies[who]), surface);
      expect(r.ok).toBe(allowed);
      if (!r.ok) expect(r.response.status).toBe(403);
    });
  }

  it("an anonymous caller gets 401, not 403, on every surface", async () => {
    const { requireRole } = await import("../lib/authz");
    for (const surface of ["member", "manager", "admin"] as const) {
      const r = await requireRole(req(), surface);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.response.status).toBe(401);
    }
  });
});
