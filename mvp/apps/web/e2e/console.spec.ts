import { test, expect } from "@playwright/test";
import { as } from "./helpers/auth";

// /console is gated on WAREHOUSD_DEMO, which the e2e web server sets. The chat itself calls
// Anthropic, so /api/chat is stubbed here — this spec covers the console's rendering and its
// NDJSON stream handling, not the model.
// The trailing newline is load-bearing: Chat.tsx buffers whatever follows the last "\n" and
// only parses complete lines, so an event without one is never delivered.
const NDJSON =
  [
    JSON.stringify({ type: "progress", label: "querying departments…" }),
    JSON.stringify({ type: "done", text: "There are **5** departments." }),
  ].join("\n") + "\n";

test.describe("chat console", () => {
  test.beforeEach(async ({ page }) => {
    await as(page, "admin");
  });

  test("the console is reachable from the sidebar in demo mode", async ({ page }) => {
    await page.getByRole("link", { name: "Chat console" }).click();
    // waitForURL, not toHaveURL: /console is compiled on first hit by the dev server and can
    // take longer than the 5s assertion timeout.
    await page.waitForURL(/\/console$/);
    await expect(page.getByRole("heading", { name: "Chat console" })).toBeVisible();
    await expect(page.getByPlaceholder(/average salary/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  });

  test("a streamed answer is rendered as markdown", async ({ page }) => {
    await page.route("**/api/chat", (route) =>
      route.fulfill({ status: 200, contentType: "application/x-ndjson", body: NDJSON }),
    );
    await page.goto("/console");

    await page.getByPlaceholder(/average salary/).fill("how many departments?");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("how many departments?")).toBeVisible();
    const answer = page.locator(".markdown");
    await expect(answer).toContainText("There are 5 departments.");
    await expect(answer.locator("strong")).toHaveText("5"); // ** ** survived the markdown render
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  test("an error event from the stream is surfaced in the transcript", async ({ page }) => {
    await page.route("**/api/chat", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body: JSON.stringify({ type: "error", message: "broker refused" }) + "\n",
      }),
    );
    await page.goto("/console");

    await page.getByPlaceholder(/average salary/).fill("show me every salary");
    await page.keyboard.press("Enter");
    await expect(page.getByText("error: broker refused")).toBeVisible();
  });

  test("a member reaches the console too, scoped to member navigation", async ({ page }) => {
    await page.getByRole("button", { name: /@demo\.local/ }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL(/\/login/);

    await as(page, "member");
    await page.goto("/console");
    await expect(page.getByRole("heading", { name: "Chat console" })).toBeVisible();
    await expect(page.getByRole("link", { name: "My grants" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Users & roles" })).toHaveCount(0);
  });
});
