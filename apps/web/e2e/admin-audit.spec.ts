import { test, expect } from "@playwright/test";
import { as, selectOption } from "./helpers/auth";

// Audit rows are written by broker query decisions (the MCP/console data path), not by the
// grant-lifecycle admin actions. A browser session cannot drive that path, so what is
// assertable here is the browser itself: filters, URL state, paging and the empty state.
// Outcome semantics (allow/deny + reason) are covered by grant-lifecycle-ui.integration.test.ts.

test.describe("audit browser", () => {
  test.beforeEach(async ({ page }) => {
    await as(page, "admin");
    await page.goto("/admin/audit");
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
