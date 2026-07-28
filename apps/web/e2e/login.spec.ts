import { test, expect } from "@playwright/test";
import { PERSONAS, signIn, signOut } from "./helpers/auth";

test.describe("login", () => {
  test("a wrong password keeps you on /login and reports the failure", async ({ page }) => {
    await page.goto("/login");
    await page.getByPlaceholder("email").fill(PERSONAS.member);
    await page.getByPlaceholder("password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("the demo credential shortcuts fill the form", async ({ page }) => {
    // WAREHOUSD_DEMO=true is set for the e2e web server, so the hints render.
    await page.goto("/login");
    await page.getByRole("button", { name: "ana@demo.local" }).click();
    await expect(page.getByPlaceholder("email")).toHaveValue("ana@demo.local");
    await expect(page.getByPlaceholder("password")).toHaveValue("demo");
  });

  test("signing out clears the session for every surface", async ({ page }) => {
    await signIn(page, PERSONAS.member);
    await expect(page).toHaveURL(/\/member$/);
    await signOut(page);
    await page.goto("/member");
    await expect(page).toHaveURL(/\/login/);
  });

  test("an unauthenticated deep link bounces to login, then lands on the role home", async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/login/);
    // The login form always returns to "/", which redirects by role — the deep link is not
    // preserved. Asserting the current behaviour, not the ideal one.
    await page.getByPlaceholder("email").fill(PERSONAS.admin);
    await page.getByPlaceholder("password").fill("demo");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/admin$/);
  });
});
