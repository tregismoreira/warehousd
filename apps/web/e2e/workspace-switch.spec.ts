import { test, expect } from "@playwright/test";
import { as } from "./helpers/auth";

// ana is a member of both 'Default' (admin) and 'Second Co' (admin) — see scripts/e2e-setup.ts.
// 'Second Co' carries no synthetic data on purpose, so its document counts are the signal that
// the switch actually changed which workspace's rows the console reads, not just a label.
test.describe("workspace switch", () => {
  // ana is the only persona with two memberships (see scripts/e2e-setup.ts) — a switcher control
  // is a Button, so this is what a >1-membership caller gets.
  test("the active workspace is named on every surface, before any switch happens", async ({
    page,
  }) => {
    await as(page, "admin");
    await page.goto("/admin");
    await expect(page.getByRole("button", { name: "Default" })).toBeVisible();
    await page.goto("/manager");
    await expect(page.getByRole("button", { name: "Default" })).toBeVisible();
    await page.goto("/member");
    await expect(page.getByRole("button", { name: "Default" })).toBeVisible();
  });

  // marcus has exactly one membership — no switcher control at all, but the workspace is still
  // named. A static span carries no button role, so this locator would fail to find anything at
  // all if the name stopped rendering, not merely show the wrong element.
  test("with one membership, the workspace is named without a switcher control", async ({
    page,
  }) => {
    await as(page, "manager");
    await page.goto("/manager");
    await expect(page.getByRole("button", { name: "Default" })).toHaveCount(0);
    await expect(page.getByTitle("Active workspace")).toHaveText("Default");
  });

  test("switching changes the collection list and the header name", async ({ page }) => {
    await as(page, "admin");
    await page.goto("/admin/collections");
    const departmentsRow = page.getByRole("row", { name: /^departments/ });
    await expect(departmentsRow).toBeVisible();
    // harbor's synthetic seed gives 'Default' real rows in every applied collection.
    await expect(departmentsRow.getByRole("cell").nth(3)).not.toHaveText("0");

    // The switcher's label moves optimistically, before the POST it triggers has landed — so the
    // label alone does not prove the active workspace actually changed server-side.
    const switched = page.waitForResponse(
      (r) => r.url().endsWith("/api/me/workspace") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Default" }).click();
    await page.getByRole("menuitem", { name: "Second Co" }).click();
    expect((await switched).status()).toBe(200);

    await expect(page.getByRole("button", { name: "Second Co" })).toBeVisible();
    // The switch reloads the server tree; the row is still there (config is global) but its
    // count now reads 'Second Co', which has never been seeded.
    await expect(departmentsRow.getByRole("cell").nth(3)).toHaveText("0");

    // ana's session is shared for the rest of the run (see `as()` in helpers/auth.ts) — switch
    // back, or every later admin-persona test inherits 'Second Co' and its empty seed data.
    const restored = page.waitForResponse(
      (r) => r.url().endsWith("/api/me/workspace") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Second Co" }).click();
    await page.getByRole("menuitem", { name: "Default" }).click();
    expect((await restored).status()).toBe(200);
    await expect(page.getByRole("button", { name: "Default" })).toBeVisible();
  });
});
