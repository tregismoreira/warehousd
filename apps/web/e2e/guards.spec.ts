import { test, expect } from "@playwright/test";
import { as } from "./helpers/auth";

test.describe("role-scoped surfaces", () => {
  test("a member lands on /member and sees only member navigation", async ({ page }) => {
    await as(page, "member");
    await expect(page).toHaveURL(/\/member$/);
    await expect(page.getByRole("link", { name: "My grants" })).toBeVisible();
    await expect(page.getByRole("link", { name: "How to connect" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Users & roles" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Grant inbox" })).toHaveCount(0);
  });

  test("a member navigating to /admin is redirected to 403", async ({ page }) => {
    await as(page, "member");
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/403$/);
    await expect(page.getByText(/don.t have access/i)).toBeVisible();
  });

  test("a member navigating to /manager is redirected to 403", async ({ page }) => {
    await as(page, "member");
    await page.goto("/manager");
    await expect(page).toHaveURL(/\/403$/);
  });

  test("a manager reaches /manager but not /admin", async ({ page }) => {
    await as(page, "manager");
    await expect(page).toHaveURL(/\/manager$/);
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/403$/);
  });

  test("an admin reaches every surface", async ({ page }) => {
    await as(page, "admin");
    await expect(page).toHaveURL(/\/admin$/);
    for (const path of ["/admin/collections", "/admin/users", "/admin/clients",
                        "/admin/sso", "/admin/audit", "/admin/import"]) {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await expect(page).not.toHaveURL(/\/403$/);
    }
  });

  test("an unauthenticated visitor is sent to login from every surface", async ({ page, context }) => {
    await context.clearCookies();
    for (const path of ["/", "/admin", "/manager", "/member"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    }
  });

  test("the env switcher persists across a reload", async ({ page }) => {
    await as(page, "admin");
    const liveBtn = page.getByRole("group", { name: "Environment" }).getByText("live");
    const envResponse = page.waitForResponse((r) => r.url().endsWith("/api/env") && r.request().method() === "POST");
    await liveBtn.click();
    await envResponse;
    await page.reload();
    await expect(liveBtn).toHaveAttribute("aria-pressed", "true");
  });
});
