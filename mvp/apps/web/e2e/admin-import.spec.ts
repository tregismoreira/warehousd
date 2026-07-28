import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { as, selectOption } from "./helpers/auth";

// `departments` is the smallest dataset collection (id uuid pk, name text) and imports land
// in data_live, which the dev-scoped grant specs never read.
const COLLECTION = "departments";

async function pickAndUpload(page: import("@playwright/test").Page, csv: string) {
  await selectOption(page, "Collection", new RegExp(`^${COLLECTION}$`));
  await selectOption(page, "Format", "CSV");
  await page.getByLabel("File").setInputFiles({
    name: "departments.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await page.getByRole("button", { name: "Review import" }).click();
  await expect(page.getByRole("heading", { name: "Confirm import" })).toBeVisible();
  await page.getByRole("button", { name: "Import" }).click();
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

  test("review is blocked until a collection and a file are chosen", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Review import" })).toBeDisabled();
    await selectOption(page, "Collection", new RegExp(`^${COLLECTION}$`));
    await expect(page.getByRole("button", { name: "Review import" })).toBeDisabled();
  });

  test("a valid CSV is imported into data_live", async ({ page }) => {
    const rows = [randomUUID(), randomUUID()];
    await pickAndUpload(page, `id,name\n${rows[0]},E2E Alpha\n${rows[1]},E2E Beta\n`);

    await expect(page.getByText("Import successful")).toBeVisible();
    await expect(page.getByText(`data_live.${COLLECTION}`)).toBeVisible();
    await expect(page.getByText("2 rows imported")).toBeVisible();
    await expect(page.getByRole("button", { name: "Import another file" })).toBeVisible();
  });

  test("an invalid CSV is rejected whole — nothing is imported", async ({ page }) => {
    await pickAndUpload(page, `id,name\nnot-a-uuid,E2E Broken\n`);

    await expect(page.getByText("Import failed")).toBeVisible();
    await expect(page.getByText("Nothing was imported.")).toBeVisible();
    // Rows are reported zero-indexed, excluding the header.
    await expect(page.getByText(/Row 0 · id · not a UUID/)).toBeVisible();
  });

  test("cancelling the confirm dialog returns to the picker", async ({ page }) => {
    await selectOption(page, "Collection", new RegExp(`^${COLLECTION}$`));
    await page.getByLabel("File").setInputFiles({
      name: "departments.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(`id,name\n${randomUUID()},E2E Cancelled\n`),
    });
    await page.getByRole("button", { name: "Review import" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { name: "Confirm import" })).toHaveCount(0);
    await expect(page.getByText("Select dataset and file")).toBeVisible();
  });
});
