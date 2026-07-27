import { expect, type BrowserContext, type Page } from "@playwright/test";

export const PERSONAS = {
  admin: "ana@demo.local",
  manager: "marcus@demo.local",
  member: "mia@demo.local",
} as const;

export type Persona = keyof typeof PERSONAS;

export async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByPlaceholder("email").fill(email);
  await page.getByPlaceholder("password").fill("demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

export async function as(page: Page, persona: Persona) {
  await signIn(page, PERSONAS[persona]);
}

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
