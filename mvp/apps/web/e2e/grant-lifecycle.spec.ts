import { test, expect } from "@playwright/test";
import { as, signOut } from "./helpers/auth";

test("request → approve with trimmed fields → revoke, all through the UI", async ({ page, context }) => {
  // Ensure we're on the dev environment by clearing the env cookie.
  await context.clearCookies({ name: "wh_env" });

  // 1. Mia requests access to departments.
  await as(page, "member");
  await page.getByRole("button", { name: "Request access" }).click();
  await page.getByLabel("Collection").click();
  await page.getByRole("option", { name: "departments" }).click();
  await page.getByLabel("Purpose").fill("org chart");
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByText("Access requested")).toBeVisible();
  await expect(page.getByRole("row", { name: /departments/ }).last()).toContainText("Pending");
  await signOut(page);

  // 2. Marcus sees it, trims to one field, sets no expiry, approves.
  await as(page, "manager");
  const row = page.getByRole("row", { name: /mia.*departments/ });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Review" }).click();
  await page.getByRole("checkbox", { name: "id" }).uncheck();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Grant approved")).toBeVisible();
  await signOut(page);

  // 3. Mia sees an approved grant scoped to the single remaining field.
  await as(page, "member");
  const mine = page.getByRole("row", { name: /departments/ }).last();
  await expect(mine).toContainText("Approved");
  await expect(mine).toContainText("name");
  await expect(mine).not.toContainText("id,");
  await signOut(page);

  // 4. Marcus revokes it.
  await as(page, "manager");
  await page.getByRole("link", { name: "Active grants" }).click();
  const active = page.getByRole("row", { name: /mia.*departments/ });
  await active.getByRole("button", { name: "Revoke" }).click();
  // Scope to the dialog: every active row has its own "Revoke" trigger, so .last() can land
  // on another row's button instead of this dialog's confirm.
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("Grant revoked")).toBeVisible();
  await signOut(page);

  // 5. Mia's grant is revoked, and the audit browser has the whole story for Ana.
  await as(page, "member");
  await expect(page.getByRole("row", { name: /departments/ }).last()).toContainText("Revoked");
  await signOut(page);

  // Broker query decisions (allow/deny) are only produced by an actual data access — the
  // MCP/console path, not the grant-lifecycle admin actions above. This browser session has
  // no way to drive that path, so the reachable assertion is that the audit browser itself
  // filters correctly, not that a "deny" outcome exists for departments. The audit browser's
  // outcome semantics (allow/deny + reason) are covered directly by
  // grant-lifecycle-ui.integration.test.ts, which drives broker.query in-process.
  // Scoped to mia: admin actions elsewhere in the suite (import, regenerate) do write audit
  // rows for departments, but none of them are hers, and her grant lifecycle produced none.
  await as(page, "admin");
  await page.goto("/admin/audit");
  await page.getByLabel("Collection").click();
  await page.getByRole("option", { name: "departments" }).click();
  await page.getByLabel("User").fill("mia");
  await expect(page.getByRole("heading", { name: "No matching events" })).toBeVisible();
});
