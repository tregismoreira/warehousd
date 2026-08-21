import { test, expect } from "@playwright/test";
import { as, resetEnv } from "./helpers/auth";

// Browsing from the console is governed, not privileged: the Data tab posts to
// /api/collections/{c}/query with the session's own context, so what an admin sees is what their
// own grants allow and every run leaves an audit row. dev-bootstrap gives Ana an approved dev
// grant on every collection and no live grant at all, which is exactly the two cases below.

test.describe("data browser", () => {
  test.beforeEach(async ({ page, context }) => {
    await as(page, "admin");
    await resetEnv(context);
  });

  test("runs a governed query and returns only the granted fields", async ({ page }) => {
    await page.goto("/admin/collections/vendors");
    await page.getByRole("tab", { name: "Data" }).click();

    // The teaching surface: three states, and the denied one can never be checked because no
    // grant could ever carry it.
    await expect(page.getByText(/denied by posture — never grantable/)).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "tax_id" })).toBeDisabled();
    await expect(page.getByRole("checkbox", { name: "name", exact: true })).toBeChecked();

    // Gate on the query landing rather than racing it: the assertion timeout is a budget for the
    // table to render, and spending it waiting for a governed read — broker, grant check, audit
    // write — is how this failed on a loaded machine while passing in isolation.
    const query = page.waitForResponse((r) => r.url().includes("/api/collections/vendors/query"));
    await page.getByRole("button", { name: "Run query" }).click();
    expect((await query).status()).toBe(200);

    await expect(page.getByRole("columnheader", { name: "name", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "tax_id" })).toHaveCount(0);
    // Every read is a decision, and the decision has an id.
    await expect(page.getByText(/audit /)).toBeVisible();
  });

  test("paging moves through the result a page at a time", async ({ page }) => {
    await page.goto("/admin/collections/people");
    await page.getByRole("tab", { name: "Data" }).click();
    const firstPage = page.waitForResponse((r) =>
      r.url().includes("/api/collections/people/query"),
    );
    await page.getByRole("button", { name: "Run query" }).click();
    expect((await firstPage).status()).toBe(200);

    // harbor generates forty people; the default page is twenty-five.
    await expect(page.getByText(/^Documents 1–25/)).toBeVisible();
    // exact: the Next.js dev-tools launcher is also a button matching /Next/.
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText(/^Documents 26–40/)).toBeVisible();
    await page.getByRole("button", { name: "Previous" }).click();
    await expect(page.getByText(/^Documents 1–25/)).toBeVisible();
  });

  test("a filter is applied to the query the broker runs", async ({ page }) => {
    await page.goto("/admin/collections/metrics");
    await page.getByRole("tab", { name: "Data" }).click();

    await page.getByRole("button", { name: "Add filter" }).click();
    await page.getByLabel("Filter 1 field").click();
    await page.getByRole("option", { name: "region", exact: true }).click();
    await page.getByLabel("Filter 1 operator").click();
    await page.getByRole("option", { name: "eq", exact: true }).click();
    await page.getByLabel("Filter 1 value").fill("no-such-region");

    const query = page.waitForResponse((r) => r.url().includes("/api/collections/metrics/query"));
    await page.getByRole("button", { name: "Run query" }).click();
    expect((await query).status()).toBe(200);

    // A filter nothing matches is the honest way to prove the filter reached the database.
    await expect(page.getByText("No documents")).toBeVisible();
  });

  test("a file collection searches its documents", async ({ page }) => {
    await page.goto("/admin/collections/policies");
    await page.getByRole("tab", { name: "Data" }).click();

    await page.getByLabel("Search").fill("remote");
    // A file collection searches rather than queries, so match the collection rather than the
    // verb — semantic search is the slowest read on this page and the one most worth gating on.
    const search = page.waitForResponse((r) => r.url().includes("/api/collections/policies/"));
    await page.getByRole("button", { name: "Run query" }).click();
    expect((await search).status()).toBe(200);

    await expect(page.getByRole("columnheader", { name: "content" })).toBeVisible();
    await expect(page.getByText(/^Documents 1–/)).toBeVisible();
  });

  // Deny-by-default reaches the console's own admin. Ana holds no live grant, so the same page
  // that just returned documents on dev returns an empty state on live.
  test("no grant is an empty state that offers to request access", async ({ page }) => {
    // Switch first, then navigate: the switcher writes the cookie and refreshes in a transition,
    // and a tab clicked into the middle of that refresh is a tab on a tree about to remount.
    // That the switch itself re-renders a page is admin-collections.spec.ts's subject.
    await page.goto("/admin");
    const envResponse = page.waitForResponse(
      (r) => r.url().endsWith("/api/env") && r.request().method() === "POST",
    );
    await page.getByRole("group", { name: "Environment" }).getByText("live").click();
    await envResponse;

    await page.goto("/admin/collections/vendors");
    await page.getByRole("tab", { name: "Data" }).click();
    await expect(page.getByText("No grant on this collection")).toBeVisible();

    // On live the approve leg is refused as a self-approval, so the one click leaves a request
    // for somebody else rather than granting the asker their own access.
    await page.getByRole("button", { name: "Request & approve access" }).click();
    await expect(page.getByText("Requested — awaiting another approver")).toBeVisible();

    // And the request really is in the manager's inbox.
    await as(page, "manager");
    await expect(page.getByRole("row", { name: /ana.*vendors/ }).last()).toContainText(
      "console browsing",
    );
  });
});
