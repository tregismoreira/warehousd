import { test, expect } from "@playwright/test";
import { as } from "./helpers/auth";

test.describe.configure({ mode: "serial" });

// Unique per run — clients are append-only from the UI, so a fixed name would collide
// on a second run against the same database.
const NAME = `e2e client ${Date.now()}`;

test.describe("OAuth clients", () => {
  test.beforeEach(async ({ page }) => {
    await as(page, "admin");
    await page.goto("/admin/clients");
  });

  test("create is blocked until the client has a name", async ({ page }) => {
    await page.getByRole("button", { name: "New client" }).click();
    await expect(page.getByRole("button", { name: "Create" })).toBeDisabled();
    await page.getByLabel("Name").fill("x");
    await expect(page.getByRole("button", { name: "Create" })).toBeEnabled();
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  test("a new client is issued a client id and secret, then appears in the table", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "New client" }).click();
    await page.getByLabel("Name").fill(NAME);
    await page.getByRole("button", { name: "Create" }).click();

    const created = page.getByRole("dialog").filter({ hasText: "Client created" });
    await expect(created).toBeVisible();
    await expect(created).toContainText("Client ID");
    await expect(created).toContainText("Client secret");
    await created.getByRole("button", { name: "Done" }).click();

    const row = page.getByRole("row", { name: new RegExp(NAME) });
    await expect(row).toBeVisible();
    // New clients start scoped to dev only.
    await expect(row).toContainText("env:dev");
    await expect(row).not.toContainText("env:live");
  });

  test("a client can be promoted to live and demoted back", async ({ page }) => {
    const row = page.getByRole("row", { name: new RegExp(NAME) });

    await row.getByRole("button", { name: "Promote" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Promote" }).click();
    await expect(page.getByText("Client promoted to env:live")).toBeVisible();
    await expect(row).toContainText("env:live");

    await row.getByRole("button", { name: "Demote" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Demote" }).click();
    await expect(page.getByText("Client demoted to env:dev")).toBeVisible();
    await expect(row).not.toContainText("env:live");
  });
});
