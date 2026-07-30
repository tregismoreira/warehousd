import { test, expect } from "@playwright/test";
import { as } from "./helpers/auth";

const COLLECTIONS = [
  "announcements",
  "case_files",
  "clients",
  "conflict_checks",
  "court_deadlines",
  "departments",
  "expenses",
  "invoices",
  "matter_tasks",
  "matters",
  "metrics",
  "people",
  "performance_reviews",
  "policies",
  "precedents",
  "pto_requests",
  "salaries",
  "time_entries",
  "trust_accounts",
  "vendors",
];

test.describe("collections", () => {
  test.beforeEach(async ({ page }) => {
    await as(page, "admin");
    await page.goto("/admin/collections");
  });

  test("every collection in warehousd.yml is rendered with its field table", async ({ page }) => {
    for (const name of COLLECTIONS) {
      const card = page.locator("[data-slot=card]").filter({
        has: page.locator("[data-slot=card-title]", { hasText: new RegExp(`^${name}$`) }),
      });
      await expect(card).toBeVisible();
      for (const header of ["Field", "Type", "Posture", "Keys"]) {
        await expect(card.getByRole("columnheader", { name: header })).toBeVisible();
      }
    }
  });

  test("deny-posture fields are marked, and keys are labelled", async ({ page }) => {
    const people = page.locator("[data-slot=card]").filter({
      has: page.locator("[data-slot=card-title]", { hasText: /^people$/ }),
    });
    // people.home_address and people.phone are posture: deny in the harbor config.
    await expect(people.getByRole("row", { name: /home_address/ })).toContainText("deny");
    await expect(people.getByRole("row", { name: /^id/ })).toContainText("allow");
    await expect(people.getByRole("row", { name: /^id/ })).toContainText("pk");
    await expect(people.getByRole("row", { name: /department_id/ })).toContainText(
      "fk:departments.id",
    );
    await expect(people.getByRole("row", { name: /department_name/ })).toContainText(
      "join:departments.name",
    );
  });

  test("the file-backed collection is typed as a file", async ({ page }) => {
    const policies = page.locator("[data-slot=card]").filter({
      has: page.locator("[data-slot=card-title]", { hasText: /^policies$/ }),
    });
    await expect(policies).toContainText("file");
  });
});
