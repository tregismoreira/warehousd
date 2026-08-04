import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { as, selectOption } from "./helpers/auth";

// `departments` is the smallest dataset collection (id uuid pk, name text) and imports land
// in data_live, which the dev-scoped grant specs never read.
const COLLECTION = "departments";

// `exact` on every button name here, deliberately. Accessible-name matching is substring and
// case-insensitive by default, so `name: "Import"` also matches "Preview import" and "Import
// another file" — which is how this file went on passing after the button was renamed, right up
// until a test needed the one button whose name had stopped containing the word.
const button = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("button", { name, exact: true });

async function pick(page: import("@playwright/test").Page, csv: string) {
  await selectOption(page, "Collection", new RegExp(`^${COLLECTION}$`));
  await selectOption(page, "Format", "CSV");
  await page.getByLabel("File").setInputFiles({
    name: "departments.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
}

/**
 * Preview, then apply.
 *
 * The preview is a real import that is rolled back, so a file that cannot be imported never
 * reaches the confirm dialog at all — which is why the invalid-CSV test below does not use this.
 */
async function pickAndUpload(page: import("@playwright/test").Page, csv: string) {
  await pick(page, csv);
  await button(page, "Preview import").click();
  await expect(page.getByRole("heading", { name: "Confirm import" })).toBeVisible();
  await button(page, "Apply").click();
}

test.describe("import", () => {
  test.beforeEach(async ({ page }) => {
    await as(page, "admin");
    await page.goto("/admin/import");
  });

  test("the expected columns for the chosen collection are shown", async ({ page }) => {
    await selectOption(page, "Collection", new RegExp(`^${COLLECTION}$`));
    await expect(page.getByText("Expected columns:")).toBeVisible();
    await expect(page.getByText("id (required)")).toBeVisible();
  });

  test("preview is blocked until a collection and a file are chosen", async ({ page }) => {
    await expect(button(page, "Preview import")).toBeDisabled();
    await selectOption(page, "Collection", new RegExp(`^${COLLECTION}$`));
    await expect(button(page, "Preview import")).toBeDisabled();
  });

  test("a valid CSV is imported into data_live", async ({ page }) => {
    const rows = [randomUUID(), randomUUID()];
    await pickAndUpload(page, `id,name\n${rows[0]},E2E Alpha\n${rows[1]},E2E Beta\n`);

    // Scoped to the result card: the same summary is also announced in a toast, and an
    // unscoped match resolves to both.
    const panel = page.locator("[data-slot=card]").filter({ hasText: "Import successful" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(`data_live.${COLLECTION}`)).toBeVisible();
    // Broken down by what happened to each document rather than one total: "2 added" on an
    // append, "4 added, 96 revised" on an upsert.
    await expect(panel.getByText("2 added")).toBeVisible();
    await expect(button(page, "Import another file")).toBeVisible();
  });

  test("the preview says what will happen before anything is applied", async ({ page }) => {
    // The counts come from running the import for real and rolling it back, so this is the one
    // place an admin can see "4 new, 96 revised" before deciding.
    await pick(page, `id,name\n${randomUUID()},E2E Previewed\n`);
    await button(page, "Preview import").click();

    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("1 added")).toBeVisible();
    await expect(dialog.getByText(/rolled back/)).toBeVisible();
  });

  test("an invalid CSV is rejected by the preview — nothing is applied", async ({ page }) => {
    // No confirm dialog: the dry run refuses the file, so there is nothing to confirm and the
    // per-row errors are what the admin needs instead.
    await pick(page, `id,name\nnot-a-uuid,E2E Broken\n`);
    await button(page, "Preview import").click();

    await expect(page.getByRole("heading", { name: "Confirm import" })).toHaveCount(0);
    await expect(page.getByText("Import failed")).toBeVisible();
    await expect(page.getByText("Nothing was imported.")).toBeVisible();
    // Rows are reported zero-indexed, excluding the header.
    await expect(page.getByText(/Row 0 · id · not a UUID/)).toBeVisible();
  });

  test("cancelling the confirm dialog returns to the picker", async ({ page }) => {
    await pick(page, `id,name\n${randomUUID()},E2E Cancelled\n`);
    await button(page, "Preview import").click();
    await button(page, "Cancel").click();
    await expect(page.getByRole("heading", { name: "Confirm import" })).toHaveCount(0);
    await expect(page.getByText("Select dataset and file")).toBeVisible();
  });
});
