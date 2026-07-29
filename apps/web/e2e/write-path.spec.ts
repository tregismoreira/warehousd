import { test, expect, type Page } from "@playwright/test";
import { as, expectToast } from "./helpers/auth";

// `/v1/*` is machine-auth (Bearer token), never session cookies — so "mia proposes a
// document" is driven through a real headless API key + client_credentials token exchange,
// exactly like the plan's own end-to-end proof sequence. Everything a human does through
// the console (review, approve, revoke) still goes through the normal session-cookie UI.
async function mintMiaToken(page: Page) {
  const keyRes = await page.request.post("/api/api-keys", {
    data: { name: `e2e-mia-robot-${Date.now()}`, mode: "headless", robotUserId: "mia" },
  });
  expect(keyRes.status()).toBe(201);
  const { clientId, secret } = await keyRes.json();

  const tokenRes = await page.request.post("/v1/token", {
    form: {
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: secret,
      scope: "env:dev",
    },
  });
  expect(tokenRes.status()).toBe(200);
  const { access_token: token } = await tokenRes.json();
  return token as string;
}

async function proposeTask(page: Page, token: string, title: string) {
  const res = await page.request.post("/v1/collections/matter_tasks/documents", {
    headers: { authorization: `Bearer ${token}` },
    data: { title, notes: "needs approval", assignee: "mia" },
  });
  expect(res.status()).toBe(202); // Accepted, pending approval
  const { proposalId } = await res.json();
  expect(proposalId).toBeTruthy();
  return proposalId as string;
}

// The queue lists metadata and CHANGED FIELD NAMES only — never a field's value. So a row is
// addressed by collection + requester, never by the title the proposer submitted.
const queueRow = (page: Page) => page.getByRole("row", { name: /matter_tasks.*mia/ });

test.describe("governed write path", () => {
  test("proposal → review queue → approve → visible in query", async ({ page, context }) => {
    await context.clearCookies({ name: "wh_env" });

    await as(page, "admin");
    const token = await mintMiaToken(page);
    await proposeTask(page, token, "Proposed task");

    // Marcus (holds approve on matter_tasks) sees it and approves it.
    await as(page, "manager");
    await page.goto("/manager/review");
    await expect(page.getByRole("heading", { name: "Proposal review" })).toBeVisible();

    const row = queueRow(page);
    await expect(row).toBeVisible();
    await expect(row).toContainText("create");

    await row.getByRole("button", { name: "Review" }).click();

    // The reviewer must see what they are approving. A create has no live document yet —
    // it is invisible until approved — so this content can only come from the pending
    // revision, read back through the reviewer's own grant.
    await expect(page.getByText("Proposed content")).toBeVisible();
    await expect(page.getByText("Proposed task", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Approve" }).click();
    await expectToast(page, /approved/i);

    // Queue drains once approved.
    await page.goto("/manager/review");
    await expect(page.getByText("No pending proposals")).toBeVisible();

    // The approved document is now readable through the REST API.
    const queryRes = await page.request.post("/v1/collections/matter_tasks/query", {
      headers: { authorization: `Bearer ${token}` },
      data: {
        fields: ["id", "title", "notes", "assignee"],
        filters: [{ field: "title", op: "eq", value: "Proposed task" }],
      },
    });
    expect(queryRes.status()).toBe(200);
    const { documents } = await queryRes.json();
    expect(documents.length).toBeGreaterThan(0);
    expect(documents[0].title).toBe("Proposed task");
  });

  test("revoking the approver's grant removes the queue item and refuses approval", async ({ page, context }) => {
    await context.clearCookies({ name: "wh_env" });

    await as(page, "admin");
    const token = await mintMiaToken(page);
    const proposalId = await proposeTask(page, token, "Second proposal");

    // Grants are revoked from the manager surface ("Active grants"), not an admin page.
    await as(page, "manager");
    await page.goto("/manager/grants");
    const grantRow = page.getByRole("row", { name: /marcus.*matter_tasks/ });
    await expect(grantRow).toBeVisible();
    await grantRow.getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
    await expectToast(page, /revoked/i);

    // Denied means absent: without `approve` on matter_tasks the proposal is not merely
    // un-approvable, it is not listed at all.
    await page.goto("/manager/review");
    await expect(page.getByText("No pending proposals")).toBeVisible();

    // And the approval itself is refused, not just hidden from the UI.
    const res = await page.request.post(`/api/proposals/${proposalId}/approve`);
    expect(res.status()).toBe(403);
  });

  test("member without approve grant cannot see review queue", async ({ page, context }) => {
    await context.clearCookies({ name: "wh_env" });

    // Mia (member) hits /manager's server-side role gate, which redirects below "manager".
    await as(page, "member");
    await page.goto("/manager/review");
    await page.waitForURL(/\/403/);
  });
});
