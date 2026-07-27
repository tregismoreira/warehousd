import { test, expect } from "@playwright/test";
import { as } from "./helpers/auth";

// A configured provider flips /login into SSO-first mode, which would change what
// login.spec.ts sees. Everything added here is removed again before the file ends, and
// afterAll deletes best-effort in case an assertion aborted a test mid-flight.
const SAML_ID = "e2e-saml";
const OIDC_ID = "e2e-oidc";

// Self-signed throwaway cert body — never used for a real handshake, the SAML registration
// path only stores it.
const CERT = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBkTCB+wIJAKZ0Z0Z0Z0Z0MA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBmU",
  "yZS1jYTAeFw0yNDAxMDEwMDAwMDBaFw0zNDAxMDEwMDAwMDBaMBExDzANBgNVBA",
  "-----END CERTIFICATE-----",
].join("\n");

test.describe.configure({ mode: "serial" });

test.describe("SSO providers", () => {
  test.beforeEach(async ({ page }) => {
    await as(page, "admin");
    await page.goto("/admin/sso");
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await as(page, "admin");
    for (const id of [SAML_ID, OIDC_ID]) {
      await page.request.delete(`/api/sso/providers/${id}`).catch(() => {});
    }
    await page.close();
  });

  test("with no providers the status card warns that local login is the only way in", async ({
    page,
  }) => {
    await expect(page.getByText("No SSO configured")).toBeVisible();
    await expect(page.getByRole("heading", { name: "No providers configured" })).toBeVisible();
  });

  test("an OIDC provider whose issuer fails discovery is rejected", async ({ page }) => {
    await page.getByRole("button", { name: "Add provider" }).click();
    await page.getByRole("tab", { name: "OIDC" }).click();
    await page.getByLabel("Provider ID").fill(OIDC_ID);
    await page.getByLabel("Issuer URL").fill("https://oidc.invalid.e2e.test");
    await page.getByLabel("Email domain").fill("invalid.e2e.test");
    await page.getByLabel("Client ID").fill("warehousd");
    await page.getByLabel("Client secret").fill("s3cret");
    await page.getByRole("dialog").getByRole("button", { name: "Add provider" }).click();

    await expect(page.getByText(/^Error:/)).toBeVisible({ timeout: 30_000 });
    // The sheet stays open on failure so the form can be corrected; close it to reach the
    // table underneath and confirm nothing was registered.
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { name: "No providers configured" })).toBeVisible();
  });

  test("required fields are enforced before anything is sent", async ({ page }) => {
    await page.getByRole("button", { name: "Add provider" }).click();
    await page.getByRole("tab", { name: "SAML" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Add provider" }).click();
    await expect(page.getByText("All fields are required")).toBeVisible();
  });

  test("a SAML provider can be registered and deleted", async ({ page }) => {
    await page.getByRole("button", { name: "Add provider" }).click();
    await page.getByRole("tab", { name: "SAML" }).click();
    await page.getByLabel("Provider ID").fill(SAML_ID);
    await page.getByLabel("Issuer URL").fill("https://saml.e2e.example.com");
    await page.getByLabel("Email domain").fill("e2e.example.com");
    await page.getByLabel("Entry Point").fill("https://saml.e2e.example.com/sso");
    await page.getByLabel("X.509 Certificate").fill(CERT);
    await page.getByRole("dialog").getByRole("button", { name: "Add provider" }).click();

    await expect(page.getByText("SAML provider added successfully")).toBeVisible();
    const row = page.getByRole("row", { name: new RegExp(SAML_ID) });
    await expect(row).toBeVisible();
    await expect(row).toContainText("SAML");
    await expect(row).toContainText("e2e.example.com");
    // With a provider AND local login, both routes are open.
    await expect(page.getByText("SSO configured")).toBeVisible();

    await row.getByRole("button").last().click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm.getByRole("heading", { name: `Delete ${SAML_ID}?` })).toBeVisible();
    const deleted = page.waitForResponse(
      (r) => r.url().includes(`/api/sso/providers/${SAML_ID}`) && r.request().method() === "DELETE",
    );
    await confirm.getByRole("button", { name: "Delete" }).click();
    expect((await deleted).status()).toBe(200);
    await expect(page.getByText("Provider deleted")).toBeVisible();
    await expect(page.getByRole("heading", { name: "No providers configured" })).toBeVisible();
  });
});
