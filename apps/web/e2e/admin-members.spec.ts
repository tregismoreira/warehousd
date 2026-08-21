import { test, expect } from "@playwright/test";
import { as } from "./helpers/auth";

// The per-workspace Members page (PR #80): apps/web/app/admin/members. Route coverage lives in
// apps/web/test/admin-members.integration.test.ts; this drives the console page itself.
//
// Every persona dev-bootstrap seeds becomes a 'default' workspace member with a role matching
// their global one — the databaseHooks.user.create.after hook in apps/web/lib/auth.ts adds a
// 'default' row on signup, and scripts/dev-bootstrap.ts corrects its role onto the fixed persona
// ids (ana admin, marcus manager, mia member). 'Second Co' carries only ana, added by
// scripts/e2e-setup.ts specifically so a >1-membership caller exists — see
// workspace-switch.spec.ts, which explains why it is left with no synthetic data otherwise.
test.describe("admin members", () => {
  test("the active workspace's members are listed with their workspace role", async ({
    page,
    context,
  }) => {
    await context.clearCookies({ name: "wh_env" });
    await as(page, "admin");
    await page.goto("/admin/members");

    const anaRow = page.getByRole("row", { name: /ana@demo\.local/ });
    const marcusRow = page.getByRole("row", { name: /marcus@demo\.local/ });
    const miaRow = page.getByRole("row", { name: /mia@demo\.local/ });
    await expect(anaRow).toBeVisible();
    await expect(marcusRow).toBeVisible();
    await expect(miaRow).toBeVisible();
    await expect(anaRow).toContainText("Admin");
    await expect(marcusRow).toContainText("Manager");
    await expect(miaRow).toContainText("Member");
  });

  test("switching workspace changes the members list", async ({ page, context }) => {
    await context.clearCookies({ name: "wh_env" });
    await as(page, "admin");
    await page.goto("/admin/members");
    await expect(page.getByRole("row", { name: /marcus@demo\.local/ })).toBeVisible();

    await page.getByRole("button", { name: "Default" }).click();
    await page.getByRole("menuitem", { name: "Second Co" }).click();
    await expect(page.getByRole("button", { name: "Second Co" })).toBeVisible();

    // 'Second Co' carries no synthetic membership beyond ana herself — marcus and mia belong
    // only to 'default', so their rows must be gone, not merely relabelled by the switch.
    await expect(page.getByRole("row", { name: /marcus@demo\.local/ })).toHaveCount(0);
    await expect(page.getByRole("row", { name: /mia@demo\.local/ })).toHaveCount(0);
    const anaRow = page.getByRole("row", { name: /ana@demo\.local/ });
    await expect(anaRow).toBeVisible();
    await expect(anaRow).toContainText("Admin");

    // ana's session is shared for the rest of the run (see `as()` in helpers/auth.ts) — switch
    // back, or every later admin-persona test inherits 'Second Co' and its empty seed data.
    await page.getByRole("button", { name: "Second Co" }).click();
    await page.getByRole("menuitem", { name: "Default" }).click();
    await expect(page.getByRole("button", { name: "Default" })).toBeVisible();
  });

  test("a manager cannot reach the page", async ({ page, context }) => {
    await context.clearCookies({ name: "wh_env" });
    // Marcus, not mia: managing membership is admin-only, and a manager is the closer boundary
    // than a member is — everything else in the console already treats manager as privileged.
    await as(page, "manager");
    await page.goto("/admin/members");
    await page.waitForURL(/\/403/);
  });
});
