import { test, expect } from "@playwright/test";
import { as, expectToast } from "./helpers/auth";

test.describe.configure({ mode: "serial" });

// Issuers are append-only from the UI and the e2e database is not reset between playwright
// invocations, so a fixed issuer URL would make every row lookup ambiguous on a second run.
const RUN = Date.now().toString(36);
const ISSUER = `https://idp-${RUN}.example.com`;
const JWKS = `${ISSUER}/.well-known/jwks.json`;
const AUDIENCE = `warehousd-${RUN}`;

test.describe("trusted issuers", () => {
  test.beforeEach(async ({ page }) => {
    await as(page, "admin");
    await page.goto("/admin/trusted-issuers");
  });

  test("adding is blocked until issuer, JWKS URI and audience are all filled", async ({ page }) => {
    await page.getByRole("button", { name: "Add issuer" }).click();
    const dialog = page.getByRole("dialog");
    // The trigger carries the same label as the submit, so scope to the dialog.
    const submit = dialog.getByRole("button", { name: "Add issuer" });

    await expect(submit).toBeDisabled();
    await dialog.getByLabel("Issuer URL").fill(ISSUER);
    await expect(submit).toBeDisabled();
    await dialog.getByLabel("JWKS URI").fill(JWKS);
    await expect(submit).toBeDisabled();
    // Subject claim is the only optional field — those three are the whole requirement.
    await dialog.getByLabel("Audience").fill(AUDIENCE);
    await expect(submit).toBeEnabled();

    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  test("a registered issuer appears in the table", async ({ page }) => {
    await page.getByRole("button", { name: "Add issuer" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Issuer URL").fill(ISSUER);
    await dialog.getByLabel("JWKS URI").fill(JWKS);
    await dialog.getByLabel("Audience").fill(AUDIENCE);
    await dialog.getByRole("button", { name: "Add issuer" }).click();
    await expectToast(page, "Trusted issuer added");

    const row = page.getByRole("row", { name: new RegExp(RUN) });
    await expect(row).toBeVisible();
    await expect(row).toContainText(JWKS);
    await expect(row).toContainText(AUDIENCE);
    // Subject claim was left blank, so the server's default of `sub` stands.
    await expect(row.getByRole("cell").nth(3)).toHaveText("sub");
  });
});

test.describe("trusted issuers, as a member", () => {
  test("a member is redirected to 403", async ({ page }) => {
    await as(page, "member");
    await page.goto("/admin/trusted-issuers");
    await expect(page).toHaveURL(/\/403$/);
  });
});
