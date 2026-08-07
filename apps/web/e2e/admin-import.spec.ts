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
 * Pick a file, then walk the mapping step to the preview.
 *
 * The mapping step sits between file selection and preview because a real spreadsheet's headers
 * are not field names. It is not skippable: a header the admin leaves unmapped would be refused
 * as `unknown_column`, and that is a decision to make before running the import, not after.
 */
async function pickAndMap(page: import("@playwright/test").Page, csv: string) {
  await pick(page, csv);
  await button(page, "Map columns").click();
  // `CardTitle` renders a div, not a heading — unlike `AlertDialogTitle` below, which
  // Radix does give role=heading. Matched by text for that reason.
  await expect(page.getByText("Map the columns")).toBeVisible();
  await button(page, "Preview import").click();
}

/**
 * Preview, then apply.
 *
 * The preview is a real import that is rolled back, so a file that cannot be imported never
 * reaches the confirm dialog at all — which is why the invalid-CSV test below does not use this.
 */
async function pickAndUpload(page: import("@playwright/test").Page, csv: string) {
  await pickAndMap(page, csv);
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

  test("the flow is blocked until a collection and a file are chosen", async ({ page }) => {
    await expect(button(page, "Map columns")).toBeDisabled();
    await selectOption(page, "Collection", new RegExp(`^${COLLECTION}$`));
    await expect(button(page, "Map columns")).toBeDisabled();
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
    await pickAndMap(page, `id,name\n${randomUUID()},E2E Previewed\n`);

    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("1 added")).toBeVisible();
    await expect(dialog.getByText(/rolled back/)).toBeVisible();
  });

  test("an invalid CSV is rejected by the preview — nothing is applied", async ({ page }) => {
    // No confirm dialog: the dry run refuses the file, so there is nothing to confirm and the
    // grouped failure is what the admin needs instead.
    await pickAndMap(page, `id,name\nnot-a-uuid,E2E Broken\n`);

    await expect(page.getByRole("heading", { name: "Confirm import" })).toHaveCount(0);
    await expect(page.getByText("Import failed")).toBeVisible();
    await expect(page.getByText("Nothing was imported.")).toBeVisible();
    // Grouped by (column, reason) with a complete count and one example row, not a list of the
    // first fifty row numbers — the same summary `warehousd import validate` prints.
    const panel = page.locator("table").filter({ hasText: "not a UUID" });
    await expect(panel.getByRole("cell", { name: "id", exact: true })).toBeVisible();
    await expect(panel.getByRole("cell", { name: "not a UUID" })).toBeVisible();
    await expect(panel.getByRole("cell", { name: "1 row", exact: true })).toBeVisible();
    // Shown 1-based, because nobody counts their spreadsheet from zero.
    await expect(panel.getByRole("cell", { name: "row 1" })).toBeVisible();
  });

  // Invariant 4 through the browser. `ImportError` carries {row, column, reason} and never the
  // value on purpose — an import file holds real personal data, and a rendered error panel is as
  // much a place a value can leak as a response body.
  test("no cell value reaches the error panel", async ({ page }) => {
    const canary = "CANARY-7f3a9b";
    await pickAndMap(page, `id,name\n${canary},E2E Canary\n`);

    await expect(page.getByText("Import failed")).toBeVisible();
    // Not scoped to the panel: the whole page, including any toast, must be free of it.
    await expect(page.locator("body")).not.toContainText(canary);
    const shown = await page.content();
    expect(shown).not.toContain(canary);
  });

  test("the mapping step proposes a config patch and never writes one", async ({ page }) => {
    // A real spreadsheet's headers are not field names. The step between file and preview is
    // where an admin corrects the guess — and "Save this mapping" produces YAML to review, not a
    // write to warehousd.yml.
    await pick(page, `ID,Name\n${randomUUID()},E2E Mapped\n`);
    await button(page, "Map columns").click();

    await expect(page.getByText("Map the columns")).toBeVisible();
    await expect(page.getByRole("cell", { name: "ID", exact: true })).toBeVisible();
    await button(page, "Save this mapping").click();
    await expect(page.getByText(/import:/)).toBeVisible();
    await expect(page.getByText(/columns:/)).toBeVisible();
  });

  test("Excel is a selectable format", async ({ page }) => {
    await selectOption(page, "Collection", new RegExp(`^${COLLECTION}$`));
    await selectOption(page, "Format", "Excel (.xlsx)");
    await expect(page.getByLabel("File")).toBeVisible();
  });

  test("cancelling the confirm dialog returns to the picker", async ({ page }) => {
    await pickAndMap(page, `id,name\n${randomUUID()},E2E Cancelled\n`);
    await button(page, "Cancel").click();
    await expect(page.getByRole("heading", { name: "Confirm import" })).toHaveCount(0);
    await expect(page.getByText("Select dataset and file")).toBeVisible();
  });
});
