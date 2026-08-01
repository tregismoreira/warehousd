import { expect, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PERSONAS = {
  admin: "ana@demo.local",
  manager: "marcus@demo.local",
  member: "mia@demo.local",
} as const;

export type Persona = keyof typeof PERSONAS;

/** `/` redirects by role, so this is where a persona lands when nothing else was asked for. */
export const HOME: Record<Persona, RegExp> = {
  admin: /\/admin$/,
  manager: /\/manager$/,
  member: /\/member$/,
};

// Written by the `setup` project (auth.setup.ts), read by `as()` below. Gitignored — these hold
// live session cookies, for the throwaway e2e database but live all the same.
const AUTH_DIR = resolve(fileURLToPath(import.meta.url), "../../.auth");
export const statePath = (persona: Persona): string => resolve(AUTH_DIR, `${persona}.json`);

type Cookies = Parameters<BrowserContext["addCookies"]>[0];

function storedCookies(persona: Persona): Cookies {
  const path = statePath(persona);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    // The `setup` project is a dependency of `e2e`, so Playwright runs it even for a filtered
    // single-file run. Reaching this means setup failed, not that the caller forgot something.
    throw new Error(`no stored session for ${persona} at ${path} — did the "setup" project run?`, {
      cause: err,
    });
  }
  return (JSON.parse(raw) as { cookies: Cookies }).cookies;
}

/** Sign in through the form. The slow path, and deliberately so: auth.setup.ts and login.spec.ts. */
export async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByPlaceholder("email").fill(email);
  await page.getByPlaceholder("password").fill("demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

/**
 * Become `persona` by adopting the session `auth.setup.ts` opened for it.
 *
 * Nearly every test here signs in only in order to *be* someone, and the form costs a page load,
 * a POST and a password hash every time — which was the bulk of this suite's runtime. Swapping
 * the cookie jar costs one navigation. That signing in works at all is still proved for real, by
 * login.spec.ts, which is the file that owns the question.
 *
 * The jar is shared for the whole run, so `signOut()` after this revokes the session for every
 * later test too. Switch persona by calling `as()` again — it clears cookies first — rather than
 * signing out in between.
 */
export async function as(page: Page, persona: Persona) {
  const context = page.context();
  // Cleared, not merged: a mid-test persona switch must leave nothing of the previous one
  // behind, neither its session nor the `wh_env` it may have chosen.
  await context.clearCookies();
  await context.addCookies(storedCookies(persona));
  await page.goto("/");
  // Landing on /login instead means the stored session is gone. Say which persona and why it
  // might be, rather than let the caller's first assertion time out against a login form.
  await expect(
    page,
    `${persona}'s stored session was rejected — has something signed this persona out?`,
  ).toHaveURL(HOME[persona]);
}

/**
 * Sign out through the UI, revoking the session server-side.
 *
 * That revocation is why this is not the way to switch persona: after `as()` the session belongs
 * to the whole run. Use it where signing out is the subject, not the setup.
 */
export async function signOut(page: Page) {
  await page.getByRole("button", { name: /@demo\.local/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/);
}

/** Drop the env cookie so a spec starts on `dev` regardless of what ran before it. */
export async function resetEnv(context: BrowserContext) {
  await context.clearCookies({ name: "wh_env" });
}

/**
 * Radix `Select` renders a listbox in a portal — pick an option by its trigger label.
 * `label` is the `htmlFor` target of the trigger, `option` the visible item text.
 */
export async function selectOption(
  page: Page,
  label: string | RegExp,
  option: string | RegExp,
  { exact = false }: { exact?: boolean } = {},
) {
  await page.getByLabel(label, { exact }).click();
  await page.getByRole("option", { name: option }).click();
}

/** Sonner renders toasts as `status` regions; assert on the title text. */
export async function expectToast(page: Page, text: string | RegExp) {
  await expect(page.getByText(text).first()).toBeVisible();
}
