import { test, expect } from "@playwright/test";
import { PERSONAS, as } from "./helpers/auth";

test.describe.configure({ mode: "serial" });

test.describe("users & roles", () => {
  test.beforeEach(async ({ page }) => {
    await as(page, "admin");
    await page.goto("/admin/users");
  });

  test("every persona is listed with its role", async ({ page }) => {
    for (const [role, email] of Object.entries(PERSONAS)) {
      const row = page.getByRole("row", { name: new RegExp(email) });
      await expect(row).toBeVisible();
      await expect(row.getByRole("combobox")).toContainText(new RegExp(role, "i"));
    }
  });

  test("an admin cannot change their own role", async ({ page }) => {
    const own = page.getByRole("row", { name: new RegExp(PERSONAS.admin) }).getByRole("combobox");
    await expect(own).toBeDisabled();
    await own.hover({ force: true });
    await expect(page.getByText("You cannot change your own role.")).toBeVisible();
  });

  // Every other spec file depends on mia being a member. Restore it unconditionally, so a
  // failure inside the test below cannot leave her promoted and poison the rest of the run.
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await as(page, "admin");
    await page.request.patch(`/api/admin/users/mia`, { data: { role: "member" } });
    await page.close();
  });

  test("a member can be promoted and demoted again", async ({ page }) => {
    const roleOf = () =>
      page.getByRole("row", { name: new RegExp(PERSONAS.member) }).getByRole("combobox");

    // RoleSelect reloads the whole page on success, so wait for the PATCH to land rather than
    // racing the navigation it triggers.
    const setRole = async (label: "Manager" | "Member") => {
      const patched = page.waitForResponse(
        (r) => r.url().includes("/api/admin/users/mia") && r.request().method() === "PATCH",
      );
      await roleOf().click();
      await page.getByRole("option", { name: label }).click();
      expect((await patched).status()).toBe(200);
      await page.waitForURL(/\/admin\/users$/);
      await expect(roleOf()).toContainText(label);
    };

    await setRole("Manager");
    await setRole("Member");
  });
});
