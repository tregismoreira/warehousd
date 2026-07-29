import { test, expect } from "@playwright/test";
import { as, resetEnv, selectOption, signOut } from "./helpers/auth";

// dev-bootstrap seeds mia with announcements/people/policies approved and a *pending*
// salaries request ("comp benchmarking") already sitting in Marcus's inbox. That leaves only
// `departments` (owned by grant-lifecycle.spec.ts) and `metrics` free to request — so the
// approval path here reviews the seeded request rather than inventing a new one.
const DENIED = "metrics";
const SEEDED_PENDING = "salaries";

test.describe.configure({ mode: "serial" });

test.describe("manager review", () => {
  test.beforeEach(async ({ context }) => {
    await resetEnv(context);
  });

  test("a request can be denied outright", async ({ page }) => {
    await as(page, "member");
    await page.getByRole("button", { name: "Request access" }).click();
    await selectOption(page, "Collection", new RegExp(`^${DENIED}$`));
    await page.getByLabel("Purpose").fill("capacity planning");
    await page.getByRole("button", { name: "Submit request" }).click();
    await expect(page.getByText("Access requested")).toBeVisible();
    await signOut(page);

    await as(page, "manager");
    const row = page.getByRole("row", { name: new RegExp(`mia.*${DENIED}`) }).last();
    await expect(row).toContainText("capacity planning");
    await row.getByRole("button", { name: "Review" }).click();
    await expect(page.getByRole("dialog")).toContainText("wants");
    await page.getByRole("button", { name: "Deny" }).click();
    await expect(page.getByText("Request denied")).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(`mia.*${DENIED}`) })).toHaveCount(0);
    await signOut(page);

    await as(page, "member");
    await expect(page.getByRole("row", { name: new RegExp(DENIED) }).last()).toContainText("Denied");
  });

  test("approval trims fields and can attach an expiry", async ({ page }) => {
    await as(page, "manager");
    const row = page.getByRole("row", { name: new RegExp(`mia.*${SEEDED_PENDING}`) });
    await expect(row).toContainText("comp benchmarking");
    await row.getByRole("button", { name: "Review" }).click();
    const sheet = page.getByRole("dialog");

    // A manager can only narrow the request, never widen it — with nothing checked there is
    // nothing left to grant.
    for (const box of await sheet.getByRole("checkbox").all()) await box.uncheck();
    await expect(sheet.getByRole("button", { name: "Approve" })).toBeDisabled();
    await sheet.getByRole("checkbox", { name: "job_title" }).check();
    await sheet.getByRole("checkbox", { name: "base_salary" }).check();
    await expect(sheet.getByRole("button", { name: "Approve" })).toBeEnabled();

    const expiry = new Date(Date.now() + 7 * 24 * 3600_000).toISOString().slice(0, 16);
    await sheet.getByLabel("Expires").fill(expiry);
    await sheet.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Grant approved")).toBeVisible();
    await signOut(page);

    await as(page, "member");
    const mine = page.getByRole("row", { name: new RegExp(SEEDED_PENDING) }).last();
    await expect(mine).toContainText("Approved");
    await expect(mine).toContainText("job_title, base_salary");
    // ssn is posture: deny and was never grantable; person_id was trimmed away here.
    await expect(mine).not.toContainText("ssn");
    await expect(mine).not.toContainText("person_id");
    await expect(mine).not.toContainText("No expiry");
  });

  test("an approved grant is listed as active and can be revoked", async ({ page }) => {
    await as(page, "manager");
    await page.getByRole("link", { name: "Active grants" }).click();
    await page.waitForURL(/\/manager\/grants$/);

    const active = page.getByRole("row", { name: new RegExp(`mia.*${SEEDED_PENDING}`) });
    await expect(active).toBeVisible();
    await active.getByRole("button", { name: "Revoke" }).click();
    // The confirm dialog lives outside the table, so a refetch no longer detaches it — but
    // assert it rendered before clicking through, so a regression fails here rather than as a
    // mystery timeout on the toast.
    const confirm = page.getByRole("alertdialog");
    await expect(confirm.getByText(/Revoke .* access to /)).toBeVisible();
    await confirm.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("Grant revoked")).toBeVisible();
    await expect(active).toHaveCount(0);
  });

  test("the inbox lists the columns a reviewer decides on", async ({ page }) => {
    await as(page, "manager");
    for (const header of ["Requester", "Collection", "Env", "Purpose", "Requested"]) {
      await expect(page.getByRole("columnheader", { name: header })).toBeVisible();
    }
  });
});
