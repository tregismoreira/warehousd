import { test, expect } from "@playwright/test";
import { as, resetEnv } from "./helpers/auth";

// mia's seeded grants (dev-bootstrap): announcements + people approved, policies approved and
// scoped to two taxonomy terms, salaries pending. Assertions here read that fixture rather
// than requesting new collections — manager.spec.ts and grant-lifecycle.spec.ts own the only
// two collections a member can still request.

test.describe("member surfaces", () => {
  test.beforeEach(async ({ page, context }) => {
    await resetEnv(context);
    await as(page, "member");
  });

  test("the grants table explains the deny-by-default posture", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "My grants" })).toBeVisible();
    await expect(page.getByText(/Access is deny-by-default/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Request access" })).toBeVisible();
  });

  test("a grant shows only its granted fields, never a deny-posture one", async ({ page }) => {
    // meridian marks people.home_address and people.phone as posture: deny, so they can never
    // appear on a grant.
    const people = page.getByRole("row", { name: /people/ });
    await expect(people).toContainText("Approved");
    await expect(people).toContainText("full_name");
    await expect(people).not.toContainText("home_address");
    await expect(people).not.toContainText("phone");
  });

  test("a document-scoped grant reports its restriction, an unscoped one says so", async ({
    page,
  }) => {
    await expect(page.getByRole("row", { name: /policies/ })).toContainText(
      'category in ["hr","benefits"]',
    );
    await expect(page.getByRole("row", { name: /announcements/ })).toContainText(
      "Whole collection",
    );
  });

  test("the request sheet requires a purpose and hides already-granted collections", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Request access" }).click();
    const sheet = page.getByRole("dialog");
    const submit = sheet.getByRole("button", { name: "Submit request" });
    await expect(submit).toBeDisabled();

    await page.getByLabel("Collection").click();
    // Anything mia already holds is offered but not selectable.
    const granted = page.getByRole("option", { name: /people — already requested/ });
    await expect(granted).toBeVisible();
    await expect(granted).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");

    // A purpose alone is still not a request — a collection is required too.
    await page.getByLabel("Purpose").fill("headcount review");
    await expect(submit).toBeDisabled();

    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toHaveCount(0);
  });

  test("the connect guide shows the MCP endpoint and the safety boundaries", async ({ page }) => {
    await page.getByRole("link", { name: "How to connect" }).click();
    await page.waitForURL(/\/member\/connect$/);
    await expect(page.getByText("Your MCP endpoint")).toBeVisible();
    await expect(page.getByText(/\/mcp$/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy value" }).first()).toBeVisible();
    await expect(page.getByText("Settings → Connectors → Add custom connector")).toBeVisible();
    await expect(page.getByText("What Claude can and cannot do")).toBeVisible();
    await expect(page.getByText(/Claude cannot write, update or delete anything/)).toBeVisible();
  });
});
