import { test, expect, type Page } from "@playwright/test";
import { as, expectToast } from "./helpers/auth";

// Credentials come off the network response, not the DOM: the reveal dialog also prints the
// literal example "whd_dev_*" in its warning copy, and a text match for the secret would be
// ambiguous against it.
async function createKey(page: Page, name: string, robot: string, ceiling?: string) {
  await page.getByRole("button", { name: "New key" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Mode").click();
  await page.getByRole("option", { name: "Headless (robot user)" }).click();
  await page.getByLabel("Robot user ID").fill(robot);
  if (ceiling) await page.getByLabel("Collection ceiling").fill(ceiling);

  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/api-keys") && r.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Create" }).click(),
  ]);
  const { clientId, secret } = await res.json();
  expect(secret).toMatch(/^whd_dev_/);
  return { clientId, secret };
}

// Row actions live behind an icon-only dropdown trigger, so "Manage" is a menuitem.
async function openKey(page: Page, name: string) {
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row).toBeVisible();
  await row.getByRole("button").last().click();
  await page.getByRole("menuitem", { name: "Manage" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

// Minting a client_credentials token writes oauthAccessToken.userId, which is FK'd to the
// user table — so any key that will actually be exchanged for a token must name a real
// persona as its robot user, not an invented id.
const ROBOT = "mia";

// Keys are never deleted, only revoked, and the e2e database is not reset between playwright
// invocations — so fixed names collide with the previous run's rows and make every row
// lookup ambiguous. Scope each run's names to itself.
const RUN = Date.now().toString(36);

// A secret is "working" iff it can still mint a token — the property revocation must break.
async function secretWorks(page: Page, clientId: string, secret: string) {
  const res = await page.request.post("/v1/token", {
    form: {
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: secret,
      scope: "env:dev",
    },
  });
  return res.status() === 200;
}

test.beforeEach(async ({ page, context }) => {
  await context.clearCookies({ name: "wh_env" });
  await as(page, "admin");
  await page.goto("/admin/api-keys");
});

test.describe("API keys", () => {
  test("create: the secret is revealed once and is not re-fetchable after reload", async ({
    page,
  }) => {
    const { secret } = await createKey(page, `Create Key ${RUN}`, "test-robot-123");

    // Revealed exactly once, in the creation dialog.
    await expect(page.getByText(secret)).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();

    await page.reload();
    await openKey(page, `Create Key ${RUN}`);

    // Only the prefix survives; the plaintext is gone for good.
    await expect(page.getByText("Active secret")).toBeVisible();
    await expect(page.getByText(secret)).toHaveCount(0);
  });

  test("rotate: the new secret works and the old one keeps working until revoked", async ({
    page,
  }) => {
    const first = await createKey(page, `Rotate Key ${RUN}`, ROBOT);
    await page.getByRole("button", { name: "Done" }).click();

    await openKey(page, `Rotate Key ${RUN}`);
    await page.getByRole("button", { name: "Rotate secret" }).click();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/rotate") && r.request().method() === "POST"),
      page.getByRole("alertdialog").getByRole("button", { name: "Rotate" }).click(),
    ]);
    const { secret: rotated } = await res.json();
    expect(rotated).toMatch(/^whd_dev_/);
    await page.getByRole("button", { name: "Done" }).click();

    // Rotation is deliberately non-breaking: both credentials authenticate, which is what
    // makes a zero-downtime redeploy possible.
    expect(await secretWorks(page, first.clientId, rotated)).toBe(true);
    expect(await secretWorks(page, first.clientId, first.secret)).toBe(true);
  });

  test("revoke: the very next call with that secret fails", async ({ page }) => {
    const { clientId, secret } = await createKey(page, `Revoke Key ${RUN}`, ROBOT);
    await page.getByRole("button", { name: "Done" }).click();

    expect(await secretWorks(page, clientId, secret)).toBe(true);

    await openKey(page, `Revoke Key ${RUN}`);
    await page.getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
    await expectToast(page, /revoked/i);

    // No token-expiry wait — grants and secrets are read fresh per request.
    expect(await secretWorks(page, clientId, secret)).toBe(false);
    await expect(page.getByText("Active secret")).toHaveCount(0);
  });

  test("the collection ceiling is visible and editable", async ({ page }) => {
    await createKey(page, `Ceiling Key ${RUN}`, "ceiling-robot", "announcements, departments");
    await page.getByRole("button", { name: "Done" }).click();

    const row = page.getByRole("row", { name: new RegExp(`Ceiling Key ${RUN}`) });
    await expect(row).toContainText("[announcements, departments]");

    await openKey(page, `Ceiling Key ${RUN}`);
    await expect(page.getByText("[announcements, departments]")).toBeVisible();

    await page.getByRole("button", { name: "Edit" }).click();
    const input = page.getByPlaceholder(/leave empty for no limit/i);
    await input.fill("departments");
    await page.getByRole("button", { name: "Save" }).click();
    await expectToast(page, /ceiling updated/i);

    await expect(page.getByText("[departments]")).toBeVisible();
  });
});
