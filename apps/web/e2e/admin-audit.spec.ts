import { test, expect } from "@playwright/test";
import { as, resetEnv, selectOption } from "./helpers/auth";

// Audit rows are written by broker query decisions, not by the grant-lifecycle admin actions.
// The console's data browser now drives that path (admin-data-browser.spec.ts asserts the audit
// id it returns), so what is left for this file is the browser itself: filters, URL state, paging
// and the empty state. Outcome semantics (allow/deny + reason) are covered by
// grant-lifecycle-ui.integration.test.ts.

test.describe("audit browser", () => {
  test.beforeEach(async ({ page, context }) => {
    await as(page, "admin");
    await resetEnv(context);
    await page.goto("/admin/audit");
  });

  // The record of what you looked at should be scoped the same way as everything you looked at.
  // This filter used to open on "Any" while every other admin surface followed the switcher.
  test("the env filter opens on the console's own environment, and Any is still reachable", async ({
    page,
  }) => {
    await expect(page.getByLabel("Env", { exact: true })).toContainText("Dev");

    await selectOption(page, "Env", "Any", { exact: true });
    await expect(page.getByLabel("Env", { exact: true })).not.toContainText("Dev");

    const envResponse = page.waitForResponse(
      (r) => r.url().endsWith("/api/env") && r.request().method() === "POST",
    );
    await page.getByRole("group", { name: "Environment" }).getByText("live").click();
    await envResponse;
    await page.goto("/admin/audit");
    await expect(page.getByLabel("Env", { exact: true })).toContainText("Live");
  });

  test("every filter is reflected in the URL and re-applied on reload", async ({ page }) => {
    await selectOption(page, "Outcome", "Deny");
    await expect(page).toHaveURL(/outcome=refused/);

    // "Env" needs exact: the shell's environment switcher is aria-label="Environment".
    await selectOption(page, "Env", "Live", { exact: true });
    await expect(page).toHaveURL(/env=live/);

    await page.getByLabel("User").fill("mia");
    await expect(page).toHaveURL(/user=mia/);

    await selectOption(page, "Collection", /^people$/);
    await expect(page).toHaveURL(/collection=people/);

    await page.reload();
    await expect(page.getByLabel("User")).toHaveValue("mia");
    await expect(page.getByLabel("Outcome")).toContainText("Deny");
    await expect(page.getByLabel("Env", { exact: true })).toContainText("Live");
    await expect(page.getByLabel("Collection")).toContainText("people");
  });

  test("a filter combination with no matches shows the empty state", async ({ page }) => {
    await page.getByLabel("User").fill("nobody-has-this-id");
    await expect(page.getByRole("heading", { name: "No matching events" })).toBeVisible();
    await expect(page.getByText("No events")).toBeVisible();
    await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();
    // exact: the Next.js dev-tools launcher is also a button matching /Next/.
    await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  });

  test("clearing a filter widens the result set again", async ({ page }) => {
    await page.getByLabel("User").fill("nobody-has-this-id");
    await expect(page).toHaveURL(/user=nobody-has-this-id/);
    await page.getByLabel("User").fill("");
    await expect(page).not.toHaveURL(/user=/);
  });
});
