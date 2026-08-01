import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { setupWebDb } from "./helpers/web-db";
import { MAX_FAILURES, ATTEMPT_WINDOW_MINUTES } from "../lib/lockout";

let handle: Awaited<ReturnType<typeof setupWebDb>>;
let db: Pool;

const EMAIL = "mia@harbor.demo";

beforeAll(async () => {
  handle = await setupWebDb("lockout");
  db = new Pool({ connectionString: handle.appUrl, max: 2 });
}, 60_000);

afterAll(async () => {
  await db?.end();
  await handle?.end();
});

beforeEach(async () => {
  await db.query(`delete from app.login_attempts`);
});

async function signIn(password: string) {
  return handle.auth.handler(
    new Request("http://localhost:8722/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:8722" },
      body: JSON.stringify({ email: EMAIL, password }),
    }),
  );
}

describe("local credential lockout", () => {
  it("locks the account after MAX_FAILURES bad passwords and then refuses the CORRECT one", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect((await signIn("wrong-password")).status).toBeGreaterThanOrEqual(400);
    }

    const { rows } = await db.query<{ failures: number; locked_until: Date | null }>(
      `select failures, locked_until from app.login_attempts where email = $1`,
      [EMAIL],
    );
    expect(rows[0]?.failures).toBe(MAX_FAILURES);
    expect(rows[0]?.locked_until).not.toBeNull();

    // The whole point: a lock the right password walks through protects nothing.
    const locked = await signIn("demo");
    expect(locked.status).toBe(429);
    expect(locked.headers.get("set-cookie")).toBeNull();
  });

  it("does not reveal whether the locked account exists", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await signIn("wrong-password");
    const real = await signIn("demo");

    // Same treatment for an address that was never a user.
    const ghost = async (password: string) =>
      handle.auth.handler(
        new Request("http://localhost:8722/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:8722" },
          body: JSON.stringify({ email: "nobody@harbor.demo", password }),
        }),
      );
    for (let i = 0; i < MAX_FAILURES; i++) await ghost("wrong-password");
    const fake = await ghost("demo");

    expect(fake.status).toBe(real.status);
    expect(await fake.text()).toBe(await real.text());
  });

  it("lets the correct password through once the lock expires, and clears the record", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await signIn("wrong-password");
    await db.query(
      `update app.login_attempts set locked_until = now() - interval '1 minute' where email = $1`,
      [EMAIL],
    );

    expect((await signIn("demo")).status).toBe(200);

    const { rows } = await db.query(`select 1 from app.login_attempts where email = $1`, [EMAIL]);
    expect(rows.length, "a successful sign-in left the failure count behind").toBe(0);
  });

  it("does not lock an account that fails fewer than MAX_FAILURES times", async () => {
    for (let i = 0; i < MAX_FAILURES - 1; i++) await signIn("wrong-password");
    expect((await signIn("demo")).status).toBe(200);
  });

  // Without decay the counter is cumulative forever: four mistyped passwords this month and one
  // next year would lock the account.
  it("does not count failures older than the attempt window toward a lock", async () => {
    for (let i = 0; i < MAX_FAILURES - 1; i++) await signIn("wrong-password");
    // Age those failures past the window rather than sleeping through it.
    await db.query(
      `update app.login_attempts
          set last_failure_at = now() - ($1 || ' minutes')::interval * 2
        where email = $2`,
      [String(ATTEMPT_WINDOW_MINUTES), EMAIL],
    );

    // The failure that would have been the fifth is now the first.
    await signIn("wrong-password");
    const { rows } = await db.query<{ failures: number; locked_until: Date | null }>(
      `select failures, locked_until from app.login_attempts where email = $1`,
      [EMAIL],
    );
    expect(rows[0]?.failures).toBe(1);
    expect(rows[0]?.locked_until).toBeNull();
    expect((await signIn("demo")).status).toBe(200);
  });

  // The table records addresses that are not accounts exactly like ones that are, so spraying
  // distinct addresses is the growth vector. Rows that can no longer contribute to a lock are
  // collected on the next failed attempt.
  it("reclaims stale rows for addresses that never reached the threshold", async () => {
    await db.query(`delete from app.login_attempts`);
    for (const addr of ["spray-1@nowhere.test", "spray-2@nowhere.test", "spray-3@nowhere.test"]) {
      await db.query(
        `insert into app.login_attempts (email, failures, last_failure_at)
         values ($1, 1, now() - ($2 || ' minutes')::interval * 2)`,
        [addr, String(ATTEMPT_WINDOW_MINUTES)],
      );
    }
    const before = await db.query<{ c: number }>(`select count(*)::int c from app.login_attempts`);
    expect(before.rows[0]?.c).toBe(3);

    await signIn("wrong-password");

    const after = await db.query<{ email: string }>(`select email from app.login_attempts`);
    // Only the address that just failed survives; the stale spray rows are gone.
    expect(after.rows.map((r) => r.email)).toEqual([EMAIL]);
  });

  // A live lock must survive the sweep even once its last failure ages out, or an attacker could
  // simply wait out the window instead of the lock.
  it("does not collect a row whose lock is still active", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await signIn("wrong-password");
    await db.query(
      `update app.login_attempts
          set last_failure_at = now() - ($1 || ' minutes')::interval * 2
        where email = $2`,
      [String(ATTEMPT_WINDOW_MINUTES), EMAIL],
    );

    // A failure on another address runs the sweep.
    await handle.auth.handler(
      new Request("http://localhost:8722/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:8722" },
        body: JSON.stringify({ email: "someone-else@harbor.demo", password: "nope" }),
      }),
    );

    const { rows } = await db.query(`select 1 from app.login_attempts where email = $1`, [EMAIL]);
    expect(rows.length, "an active lock was swept away").toBe(1);
    expect((await signIn("demo")).status).toBe(429);
  });

  // Re-stamping locked_until on every later failure would let an attacker who keeps guessing hold
  // the account locked indefinitely — turning the control into a denial of service against its
  // owner.
  it("does not extend the lock when the attacker keeps guessing", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await signIn("wrong-password");
    const first = await db.query<{ locked_until: Date }>(
      `select locked_until from app.login_attempts where email = $1`,
      [EMAIL],
    );

    for (let i = 0; i < 3; i++) await signIn("still-wrong");
    const after = await db.query<{ locked_until: Date }>(
      `select locked_until from app.login_attempts where email = $1`,
      [EMAIL],
    );

    expect(after.rows[0]?.locked_until).toEqual(first.rows[0]?.locked_until);
  });
});
