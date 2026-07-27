import { test, expect, type Page } from "@playwright/test";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByPlaceholder("email").fill(email);
  await page.getByPlaceholder("password").fill("demo");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

test("login page shows local login form when SSO not configured", async ({ page }) => {
  await page.goto("/login");

  // With WAREHOUSD_DEMO=true and no SSO providers, should show local login form
  const emailInput = page.getByPlaceholder("email");
  const passwordInput = page.getByPlaceholder("password");
  const signInButton = page.getByRole("button", { name: "Sign in" });

  await expect(emailInput).toBeVisible();
  await expect(passwordInput).toBeVisible();
  await expect(signInButton).toBeVisible();

  // Demo credentials should be shown
  const demoList = page.getByRole("list");
  await expect(demoList).toBeVisible();
  await expect(page.getByText("ana@demo.local")).toBeVisible();
  await expect(page.getByText("marcus@demo.local")).toBeVisible();
  await expect(page.getByText("mia@demo.local")).toBeVisible();
});

test("demo credentials button pre-fills the login form", async ({ page }) => {
  await page.goto("/login");

  // Click the demo credential button for mia
  await page.getByRole("button", { name: "mia@demo.local" }).click();

  // Email and password should be pre-filled
  const emailInput = page.getByPlaceholder("email");
  const passwordInput = page.getByPlaceholder("password");

  await expect(emailInput).toHaveValue("mia@demo.local");
  await expect(passwordInput).toHaveValue("demo");
});

test("successful login redirects to home page", async ({ page }) => {
  await signIn(page, "mia@demo.local");

  // Should be redirected from /login
  await expect(page).not.toHaveURL(/\/login/);
  // Should end up somewhere inside the app (e.g., /)
  expect(page.url()).not.toMatch(/\/login/);
});

test("returnTo parameter is preserved through login flow", async ({ page }) => {
  // Use returnTo query parameters that simulate OAuth continuation
  const returnToParams = new URLSearchParams({
    client_id: "test-client",
    response_type: "code",
    redirect_uri: "http://localhost:8722/callback",
  });

  await page.goto(`/login?${returnToParams.toString()}`);

  // Fill in the login form
  await page.getByPlaceholder("email").fill("ana@demo.local");
  await page.getByPlaceholder("password").fill("demo");

  // Assert on the request to the authorize endpoint rather than on the final URL.
  // What this test is about is the handoff: that the login page carries the OAuth
  // params through sign-in instead of dropping them and landing on `/`. Where
  // authorize *ends up* is a different question — `test-client` is deliberately not
  // a registered client here, so authorize legitimately answers invalid_client and
  // the browser settles on /api/auth/error. Waiting for the final URL would be
  // asserting on client registration, not on returnTo.
  const authorizeRequest = page.waitForRequest((r) =>
    r.url().includes("/api/auth/mcp/authorize"),
  );
  await page.getByRole("button", { name: "Sign in" }).click();

  const authorizeUrl = new URL((await authorizeRequest).url());
  expect(authorizeUrl.searchParams.get("client_id")).toBe("test-client");
  expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
  expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("http://localhost:8722/callback");
});

test("loading state is shown during sso status fetch", async ({ page }) => {
  // Start navigation to login page without waiting for network requests to complete
  const navigationPromise = page.goto("/login", { waitUntil: "domcontentloaded" });

  // Check that "Loading..." text appears during page load
  // (The page shows this while fetching /api/sso/status)
  const loadingElements = page.getByText("Loading...");
  const visible = await loadingElements.isVisible().catch(() => false);

  // Wait for navigation to complete and for the form to be loaded
  await navigationPromise;
  await page.waitForLoadState("networkidle");

  // After loading completes, the login form should be visible
  await expect(page.getByPlaceholder("email")).toBeVisible();
});

test("form submission with invalid credentials shows error", async ({ page }) => {
  await page.goto("/login");

  await page.getByPlaceholder("email").fill("invalid@example.com");
  await page.getByPlaceholder("password").fill("wrongpassword");

  const signInButton = page.getByRole("button", { name: "Sign in" });
  await signInButton.click();

  // Should show error message (stays on login page)
  const errorMessage = page.getByRole("alert");
  await expect(errorMessage).toBeVisible();
});

test("SSO-first render when a provider is configured", async ({ page }) => {
  // Mock /api/sso/status to return an SSO provider
  await page.route("**/api/sso/status", (route) =>
    route.fulfill({
      json: {
        providers: [{ providerId: "okta", domain: "acme.com", type: "oidc" }],
        localLoginEnabled: true,
      },
    })
  );

  await page.goto("/login");

  // Should show SSO button instead of email/password
  await expect(page.getByRole("button", { name: /sign in with your company account/i })).toBeVisible();

  // Local login should be hidden in a collapsed <details> element
  const detailsElement = page.locator("details");
  await expect(detailsElement).toBeVisible();

  // Email input should not be visible (hidden inside collapsed details)
  await expect(page.getByPlaceholder("email")).not.toBeVisible();
});

test("collapsed local login section when both SSO and local login configured", async ({ page }) => {
  // Mock /api/sso/status to return both SSO provider and local login enabled
  await page.route("**/api/sso/status", (route) =>
    route.fulfill({
      json: {
        providers: [{ providerId: "okta", domain: "acme.com", type: "oidc" }],
        localLoginEnabled: true,
      },
    })
  );

  await page.goto("/login");

  // The <details> element should exist and be collapsed by default
  const details = page.locator("details");
  await expect(details).toBeVisible();

  // Summary should contain the expand text
  const summary = details.locator("summary");
  await expect(summary).toContainText("Use a local account");

  // Local login form should be hidden initially
  const emailInput = page.getByPlaceholder("email");
  await expect(emailInput).not.toBeVisible();

  // Click to expand and verify form becomes visible
  await summary.click();
  await expect(emailInput).toBeVisible();
});

test("no login method is configured state", async ({ page }) => {
  // Mock /api/sso/status to return no providers and local login disabled
  await page.route("**/api/sso/status", (route) =>
    route.fulfill({
      json: {
        providers: [],
        localLoginEnabled: false,
      },
    })
  );

  await page.goto("/login");

  // Should show the "No login method is configured" message
  await expect(page.getByText("No login method is configured")).toBeVisible();

  // Should not show any login form
  await expect(page.getByPlaceholder("email")).not.toBeVisible();
  await expect(page.getByRole("button", { name: /sign in/i })).not.toBeVisible();
});
