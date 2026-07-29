import { test, expect } from "@playwright/test";
import { PERSONAS, signIn, signOut } from "./helpers/auth";

test.describe("login", () => {
  test("a wrong password keeps you on /login and reports the failure", async ({ page }) => {
    await page.goto("/login");
    await page.getByPlaceholder("email").fill(PERSONAS.member);
    await page.getByPlaceholder("password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("the demo credential shortcuts fill the form", async ({ page }) => {
    // WAREHOUSD_DEMO=true is set for the e2e web server, so the hints render.
    await page.goto("/login");
    await page.getByRole("button", { name: "ana@demo.local" }).click();
    await expect(page.getByPlaceholder("email")).toHaveValue("ana@demo.local");
    await expect(page.getByPlaceholder("password")).toHaveValue("demo");
  });

  test("signing out clears the session for every surface", async ({ page }) => {
    await signIn(page, PERSONAS.member);
    await expect(page).toHaveURL(/\/member$/);
    await signOut(page);
    await page.goto("/member");
    await expect(page).toHaveURL(/\/login/);
  });

  test("an unauthenticated deep link bounces to login, then lands on the role home", async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/login/);
    // The login form always returns to "/", which redirects by role — the deep link is not
    // preserved. Asserting the current behaviour, not the ideal one.
    await page.getByPlaceholder("email").fill(PERSONAS.admin);
    await page.getByPlaceholder("password").fill("demo");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/admin$/);
  });

  // The three states below are driven by mocking /api/sso/status, because registering a real
  // provider would leak into every other spec sharing this database. They cover the branches
  // in LoginForm.tsx that depend on `providers.length` and `localLoginEnabled`.
  test("renders SSO-first and collapses local login when a provider exists", async ({ page }) => {
    await page.route("**/api/sso/status", (route) =>
      route.fulfill({
        json: {
          providers: [{ providerId: "okta", domain: "acme.com", type: "oidc" }],
          localLoginEnabled: true,
        },
      }),
    );
    await page.goto("/login");

    await expect(
      page.getByRole("button", { name: /sign in with your company account/i }),
    ).toBeVisible();

    // Local login is still reachable, but only behind the collapsed disclosure. The demo
    // credentials nest a second "More personas" disclosure inside this one, so scope to the
    // outer element's own summary rather than matching every <details> on the page.
    const details = page.locator("details").first();
    await expect(details.locator("> summary")).toContainText("Use a local account");
    await expect(page.getByPlaceholder("email")).not.toBeVisible();
    await details.locator("> summary").click();
    await expect(page.getByPlaceholder("email")).toBeVisible();
  });

  test("says so when no login method is configured", async ({ page }) => {
    await page.route("**/api/sso/status", (route) =>
      route.fulfill({ json: { providers: [], localLoginEnabled: false } }),
    );
    await page.goto("/login");

    await expect(page.getByText("No login method is configured")).toBeVisible();
    await expect(page.getByPlaceholder("email")).not.toBeVisible();
    await expect(page.getByRole("button", { name: /sign in/i })).not.toBeVisible();
  });

  test("returnTo parameters survive sign-in and reach the authorize endpoint", async ({ page }) => {
    const returnToParams = new URLSearchParams({
      client_id: "test-client",
      response_type: "code",
      redirect_uri: "http://localhost:8722/callback",
    });
    await page.goto(`/login?${returnToParams.toString()}`);
    await page.getByPlaceholder("email").fill(PERSONAS.admin);
    await page.getByPlaceholder("password").fill("demo");

    // Assert on the request to the authorize endpoint rather than on the final URL. What this
    // test is about is the handoff: that the login page carries the OAuth params through
    // sign-in instead of dropping them and landing on `/`. Where authorize *ends up* is a
    // different question — `test-client` is deliberately not a registered client here, so
    // authorize legitimately answers invalid_client and the browser settles on
    // /api/auth/error. Waiting for the final URL would assert client registration, not
    // returnTo.
    const authorizeRequest = page.waitForRequest((r) =>
      r.url().includes("/api/auth/mcp/authorize"),
    );
    await page.getByRole("button", { name: "Sign in" }).click();

    const authorizeUrl = new URL((await authorizeRequest).url());
    expect(authorizeUrl.searchParams.get("client_id")).toBe("test-client");
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("http://localhost:8722/callback");
  });
});
