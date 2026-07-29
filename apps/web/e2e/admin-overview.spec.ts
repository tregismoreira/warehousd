import { test, expect } from "@playwright/test";
import { as } from "./helpers/auth";

test.describe("admin overview", () => {
  test.beforeEach(async ({ page }) => {
    await as(page, "admin");
    await page.goto("/admin");
  });

  test("the four stat cards report counts for this deployment", async ({ page }) => {
    const card = (title: string) =>
      page.locator("[data-slot=card]").filter({
        has: page.locator("[data-slot=card-title]", { hasText: title }),
      });

    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

    // harbor defines twenty collections; the count renders once the fetch settles.
    const collections = card("Collections").getByText(/^\d+$/).first();
    await expect(collections).toHaveText("20");

    await expect(card("Users by Role")).toContainText(/\d+ admin, \d+ manager, \d+ member/);
    await expect(card("Pending Grants").getByText(/^\d+$/).first()).toBeVisible();
    await expect(card("Audit Events").getByText(/^\d+$/).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "View audit log" })).toHaveAttribute(
      "href",
      "/admin/audit",
    );
  });

  test("synthetic data can be regenerated from a seed", async ({ page }) => {
    await page.getByPlaceholder("42").fill("7");
    await page.getByRole("button", { name: "Regenerate" }).click();
    await expect(page.getByRole("heading", { name: "Regenerate synthetic data?" })).toBeVisible();
    // The dialog's confirm button is the second "Regenerate" on the page.
    await page.getByRole("button", { name: "Regenerate", exact: true }).last().click();
    await expect(page.getByText(/Regenerated \d+ collections/)).toBeVisible({ timeout: 60_000 });
  });

  test("cancelling the regenerate dialog does nothing", async ({ page }) => {
    await page.getByRole("button", { name: "Regenerate" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { name: "Regenerate synthetic data?" })).toHaveCount(0);
    await expect(page.getByText(/Regenerated \d+ collections/)).toHaveCount(0);
  });
});
