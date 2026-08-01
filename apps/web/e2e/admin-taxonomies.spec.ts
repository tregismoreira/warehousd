import { test, expect } from "@playwright/test";
import { as, resetEnv } from "./helpers/auth";

// Vocabularies were fully built and entirely invisible before this page: the only place a term
// ever surfaced was a checkbox in the approval sheet, so an approver scoping a grant to `hr` had
// no way to find out what `hr` covered.
test.describe("taxonomies", () => {
  test.beforeEach(async ({ page, context }) => {
    await as(page, "admin");
    await resetEnv(context);
    await page.goto("/admin/taxonomies");
  });

  test("is reachable from the admin navigation", async ({ page }) => {
    await page.goto("/admin");
    await page.getByRole("link", { name: "Taxonomies" }).click();
    await expect(page).toHaveURL(/\/admin\/taxonomies$/);
    await expect(page.getByRole("heading", { name: "Taxonomies", level: 1 })).toBeVisible();
  });

  test("a YAML vocabulary shows its terms and the collections bound to it", async ({ page }) => {
    const card = page.locator("[data-slot=card]").filter({
      has: page.locator("[data-slot=card-title]", { hasText: /^Department$/ }),
    });
    await expect(card).toBeVisible();
    await expect(card).toContainText("warehousd.yml");
    await expect(card).toContainText("single");

    // Bound collections are links, so the vocabulary is a way into the data it scopes.
    await expect(card.getByRole("link", { name: "policies", exact: true })).toHaveAttribute(
      "href",
      "/admin/collections/policies",
    );
    await expect(card.getByRole("row", { name: /^Litigation/ })).toBeVisible();
  });

  test("a multi-value vocabulary is marked as one", async ({ page }) => {
    const card = page.locator("[data-slot=card]").filter({
      has: page.locator("[data-slot=card-title]", { hasText: /^Tags$/ }),
    });
    await expect(card).toContainText("multiple");
  });

  // The reason terms are read from app.terms rather than resolved from the YAML: a
  // dataset-sourced vocabulary has no YAML terms at all, so a config-only resolver would show
  // `c-0042` where a person needs to read the client's name.
  test("a dataset-sourced vocabulary resolves labels rather than showing raw slugs", async ({
    page,
  }) => {
    const card = page.locator("[data-slot=card]").filter({
      has: page.locator("[data-slot=card-title]", { hasText: /^Client$/ }),
    });
    await expect(card).toContainText("clients.client_number");
    await expect(card.getByRole("link", { name: "case_files", exact: true })).toBeVisible();

    const first = card.getByRole("row").nth(1);
    await expect(first).toContainText(/c-\d{4}/);
    // The label column holds a company name, not the slug repeated back.
    await expect(first.getByRole("cell").first()).not.toContainText(/^c-\d{4}$/);
  });

  test("term counts follow the environment switcher", async ({ page }) => {
    const clients = page.locator("[data-slot=card]").filter({
      has: page.locator("[data-slot=card-title]", { hasText: /^Client$/ }),
    });
    // The dev vocabulary is synthetic: 150 generated clients, so c-0001 exists.
    await expect(clients.getByRole("row", { name: /c-0001/ })).toBeVisible();

    const envResponse = page.waitForResponse(
      (r) => r.url().endsWith("/api/env") && r.request().method() === "POST",
    );
    await page.getByRole("group", { name: "Environment" }).getByText("live").click();
    await envResponse;

    // A dataset-sourced vocabulary's terms are rows, so live has a different set entirely —
    // harbor's live seed uses C-9001/C-9002.
    await expect(clients.getByRole("row", { name: /c-9001/ })).toBeVisible();
    await expect(clients.getByRole("row", { name: /c-0001/ })).toHaveCount(0);
  });
});
