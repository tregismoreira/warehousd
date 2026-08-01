import { test, expect } from "@playwright/test";
import { as, resetEnv } from "./helpers/auth";

const DATASETS = [
  "announcements",
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
  "pto_requests",
  "salaries",
  "time_entries",
  "trust_accounts",
  "vendors",
];
const FILES = ["case_files", "policies", "precedents"];

const row = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("row").filter({ has: page.getByRole("link", { name, exact: true }) });

/** Collection · Taxonomies · Fields · Documents · Status — the count is the fourth cell. */
const documents = (page: import("@playwright/test").Page, name: string) =>
  row(page, name).getByRole("cell").nth(3);

test.describe("collections list", () => {
  test.beforeEach(async ({ page, context }) => {
    await as(page, "admin");
    await resetEnv(context);
    await page.goto("/admin/collections");
  });

  test("every collection in warehousd.yml is listed under its own kind", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: `Datasets (${DATASETS.length})` }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: `File collections (${FILES.length})` }),
    ).toBeVisible();

    for (const name of [...DATASETS, ...FILES]) {
      await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
    }
  });

  test("search narrows the list to matching collections", async ({ page }) => {
    await page.getByLabel("Search collections").fill("invoice");
    await expect(page.getByRole("link", { name: "invoices", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "people", exact: true })).toHaveCount(0);

    // A vocabulary slug is searchable too — that is how you find what a grant can be scoped by.
    await page.getByLabel("Search collections").fill("tags");
    await expect(page.getByRole("link", { name: "policies", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "invoices", exact: true })).toHaveCount(0);

    await page.getByLabel("Search collections").fill("nothing matches this");
    await expect(page.getByText("No matching collections")).toBeVisible();
  });

  test("each row carries a document count for the current environment", async ({ page }) => {
    await expect(documents(page, "people")).toHaveText("40");
    await expect(documents(page, "policies")).toHaveText(/^\d+$/);
  });

  // The switcher is rendered on every surface; before this it changed nothing an admin could see.
  test("flipping the environment changes the counts", async ({ page }) => {
    await expect(documents(page, "people")).toHaveText("40");

    const envResponse = page.waitForResponse(
      (r) => r.url().endsWith("/api/env") && r.request().method() === "POST",
    );
    await page.getByRole("group", { name: "Environment" }).getByText("live").click();
    await envResponse;

    // harbor's live seed holds a single person against forty synthetic ones.
    await expect(documents(page, "people")).toHaveText("1");
  });
});

test.describe("collection detail", () => {
  test.beforeEach(async ({ page, context }) => {
    await as(page, "admin");
    await resetEnv(context);
  });

  test("a collection is reachable from the list and linkable on its own", async ({ page }) => {
    await page.goto("/admin/collections");
    await page.getByRole("link", { name: "people", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/collections\/people$/);
    await expect(page.getByRole("heading", { name: "people" })).toBeVisible();
    await expect(page.getByText(/40 documents in/)).toBeVisible();
  });

  test("the field table shows both posture axes, keys and flags", async ({ page }) => {
    await page.goto("/admin/collections/people");

    // home_address is posture: deny in harbor — denied on both axes, and both are shown. The
    // write axis used to render as nothing at all, so "write denied" and "no write path" looked
    // identical.
    const denied = page.getByRole("row", { name: /home_address/ });
    await expect(denied).toContainText("read deny");
    await expect(denied).toContainText("write deny");

    const id = page.getByRole("row", { name: /^id/ });
    await expect(id).toContainText("read allow");
    await expect(id).toContainText("write deny");
    await expect(id).toContainText("pk");

    await expect(page.getByRole("row", { name: /department_id/ })).toContainText(
      "fk:departments.id",
    );
    await expect(page.getByRole("row", { name: /department_name/ })).toContainText(
      "join:departments.name",
    );
  });

  test("the taxonomies tab names the source and counts documents per term", async ({ page }) => {
    await page.goto("/admin/collections/policies");
    await page.getByRole("tab", { name: "Taxonomies" }).click();

    await expect(page.getByRole("heading", { name: "Department" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tags" })).toBeVisible();
    // Terms resolve to their labels, and each carries how much data it actually covers.
    await expect(page.getByRole("row", { name: /^HR/ })).toBeVisible();
  });

  test("a collection binding no vocabulary says so instead of showing an empty table", async ({
    page,
  }) => {
    await page.goto("/admin/collections/metrics");
    await page.getByRole("tab", { name: "Taxonomies" }).click();
    await expect(page.getByText("No taxonomies bound")).toBeVisible();
  });

  test("a file collection lists its files, with no path column", async ({ page }) => {
    await page.goto("/admin/collections/policies");
    await expect(page.getByText("file", { exact: true }).first()).toBeVisible();

    await page.getByRole("tab", { name: "Files" }).click();
    await expect(page.getByRole("columnheader", { name: "Title" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Documents" })).toBeVisible();
    // `path` is posture: deny in harbor. Being an admin does not produce it.
    await expect(page.getByRole("columnheader", { name: "Path" })).toHaveCount(0);
    await expect(page.getByText("remote-work.md")).toHaveCount(0);
    await expect(page.getByRole("row", { name: /Remote Work/ })).toBeVisible();
  });

  test("a dataset collection has no files tab at all", async ({ page }) => {
    await page.goto("/admin/collections/people");
    await expect(page.getByRole("tab", { name: "Files" })).toHaveCount(0);
  });
});
