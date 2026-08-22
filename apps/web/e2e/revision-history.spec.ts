import { test, expect, type Page } from "@playwright/test";
import { as } from "./helpers/auth";

// The revision timeline (#105/#106): apps/web/app/admin/collections/[name]/documents/[id]/history.
// apps/web/test/revision-routes.integration.test.ts pins the REST adapter underneath; this drives
// the console page itself, which reads history under the VIEWER's own grant.
//
// matter_tasks is harbor's only writable collection (examples/harbor/warehousd.yml), so it is the
// only one with revision history to look at, and its synthetic seed is a single create with no
// second revision. scripts/e2e-setup.ts hands marcus create+approve and mia create-only on it —
// neither has `update` — so nobody in the fixture can produce a second revision as they stand.
// Rather than assume one exists, each test mints the grant it needs itself, through the same
// request -> approve API the console's own grant lifecycle uses (POST /api/grants, mirroring
// write-path.spec.ts's headless-token pattern), then restores ana's grant to what dev-bootstrap
// left it as — read-only, every grantable field — so later tests find her back where they expect.

type GrantRow = {
  id: string;
  user_id: string;
  collection: string;
  allowed_fields: string[];
  verbs: string[];
  mode: string;
};

async function activeGrant(page: Page, userId: string, collection: string): Promise<GrantRow> {
  const res = await page.request.get("/api/grants");
  expect(res.status()).toBe(200);
  const { active } = (await res.json()) as { active: GrantRow[] };
  const row = active.find((g) => g.user_id === userId && g.collection === collection);
  if (!row) throw new Error(`no active ${collection} grant for ${userId}`);
  return row;
}

/** Revoke `current`, then request and approve a replacement with the given shape. Self-approval
 * on `dev` is allowed (approveGrant only refuses it on `live`), so ana can do this to her own
 * grant without a second person. */
async function regrant(
  page: Page,
  current: GrantRow,
  next: { requestFields: string[]; allowedFields: string[]; verbs: string[]; mode: string },
): Promise<GrantRow> {
  const revoked = await page.request.post("/api/grants", {
    data: { action: "revoke", id: current.id },
  });
  expect(revoked.status()).toBe(200);

  const requested = await page.request.post("/api/grants", {
    data: {
      action: "request",
      collection: current.collection,
      purposeLabel: "e2e revision history",
      fields: next.requestFields,
    },
  });
  expect(requested.status()).toBe(200);
  const { requestId } = (await requested.json()) as { requestId: string };

  const approved = await page.request.post("/api/grants", {
    data: {
      action: "approve",
      id: requestId,
      allowedFields: next.allowedFields,
      verbs: next.verbs,
      mode: next.mode,
    },
  });
  expect(approved.status()).toBe(200);

  return activeGrant(page, current.user_id, current.collection);
}

async function mintToken(page: Page, robotUserId: string): Promise<string> {
  const keyRes = await page.request.post("/api/api-keys", {
    data: { name: `e2e-history-${robotUserId}-${Date.now()}`, mode: "headless", robotUserId },
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

/** Create a matter_tasks document, then update it — two revisions produced through the real
 * write path (broker.mutate), the same way revision-routes.integration.test.ts seeds its own. */
async function createTwoRevisions(
  page: Page,
  token: string,
  assignee: { created: string; updated: string },
): Promise<string> {
  const createRes = await page.request.post("/v1/collections/matter_tasks/documents", {
    headers: { authorization: `Bearer ${token}` },
    data: { title: `E2E history ${Date.now()}`, notes: "first pass", assignee: assignee.created },
  });
  expect(createRes.status()).toBe(201);
  const created = await createRes.json();
  const docId = created.documentId as string;

  const updateRes = await page.request.put(`/v1/collections/matter_tasks/documents/${docId}`, {
    headers: { authorization: `Bearer ${token}` },
    data: { notes: "revised", assignee: assignee.updated },
  });
  expect(updateRes.status()).toBe(200);

  return docId;
}

test.describe("revision history", () => {
  test("revisions are listed in order, and comparing two shows only what moved", async ({
    page,
    context,
  }) => {
    await context.clearCookies({ name: "wh_env" });
    await as(page, "admin");

    const original = await activeGrant(page, "ana", "matter_tasks");
    await regrant(page, original, {
      requestFields: original.allowed_fields,
      allowedFields: original.allowed_fields,
      verbs: ["read", "create", "update"],
      mode: "direct",
    });

    const token = await mintToken(page, "ana");
    const CANARY = `e2e-canary-order-${Date.now()}`;
    const docId = await createTwoRevisions(page, token, {
      created: "first-owner",
      updated: CANARY,
    });

    // The update verb was only ever needed to seed the document's second revision — put ana back
    // to read-only before looking at history, which is the state the next test also starts from.
    const widened = await activeGrant(page, "ana", "matter_tasks");
    await regrant(page, widened, {
      requestFields: original.allowed_fields,
      allowedFields: original.allowed_fields,
      verbs: original.verbs,
      mode: original.mode,
    });

    await page.goto(`/admin/collections/matter_tasks/documents/${docId}/history`);

    const createRow = page.getByRole("row", { name: /\bcreate\b/ });
    const updateRow = page.getByRole("row", { name: /\bupdate\b/ });
    await expect(createRow).toBeVisible();
    await expect(updateRow).toBeVisible();

    // Listed oldest first, not merely both present: exactly one row per revision, in DOM order.
    const revisionRows = page.locator("table tbody tr");
    await expect(revisionRows).toHaveCount(2);
    await expect(revisionRows.nth(0)).toContainText("create");
    await expect(revisionRows.nth(1)).toContainText("update");

    await createRow.getByRole("button", { name: /^Compare from revision/ }).click();
    await updateRow.getByRole("button", { name: /^Compare to revision/ }).click();

    await expect(page.getByRole("heading", { name: "Changes" })).toBeVisible();
    const notesRow = page.getByRole("row", { name: /^notes/ });
    const assigneeRow = page.getByRole("row", { name: /^assignee/ });
    await expect(notesRow).toBeVisible();
    await expect(notesRow).toContainText("first pass");
    await expect(notesRow).toContainText("revised");
    await expect(assigneeRow).toBeVisible();
    await expect(assigneeRow).toContainText(CANARY);
    // title and created_at never changed between these two revisions — the diff has no row for
    // either, proving it shows what moved rather than the whole document twice.
    await expect(page.getByRole("row", { name: /^title/ })).toHaveCount(0);
    await expect(page.getByRole("row", { name: /^created_at/ })).toHaveCount(0);
  });

  test("a field denied by the caller's grant is absent from its own history", async ({
    page,
    context,
  }) => {
    await context.clearCookies({ name: "wh_env" });
    await as(page, "admin");

    const original = await activeGrant(page, "ana", "matter_tasks");
    await regrant(page, original, {
      requestFields: original.allowed_fields,
      allowedFields: original.allowed_fields,
      verbs: ["read", "create", "update"],
      mode: "direct",
    });

    const token = await mintToken(page, "ana");
    const CANARY = `e2e-canary-masked-${Date.now()}`;
    const docId = await createTwoRevisions(page, token, {
      created: "first-owner",
      updated: CANARY,
    });

    // Narrow ana's own grant to every field except `assignee` — the field this update changed —
    // and drop back to read-only; masking is a read-time question, not a write one.
    const widened = await activeGrant(page, "ana", "matter_tasks");
    const narrowedFields = original.allowed_fields.filter((f) => f !== "assignee");
    await regrant(page, widened, {
      requestFields: original.allowed_fields,
      allowedFields: narrowedFields,
      verbs: ["read"],
      mode: "direct",
    });

    // `finally`, because ana's grant is global to the run: leaving it narrowed after a failed
    // assertion would strip `assignee` from every later spec's reads too, turning one real
    // failure into a cascade of unrelated ones.
    try {
      await page.goto(`/admin/collections/matter_tasks/documents/${docId}/history`);

      const updateRow = page.getByRole("row", { name: /\bupdate\b/ });
      await expect(updateRow).toBeVisible();
      await expect(updateRow).toContainText("notes");
      await expect(updateRow).not.toContainText("assignee");

      const createRow = page.getByRole("row", { name: /\bcreate\b/ });
      await createRow.getByRole("button", { name: /^Compare from revision/ }).click();
      await updateRow.getByRole("button", { name: /^Compare to revision/ }).click();

      await expect(page.getByRole("heading", { name: "Changes" })).toBeVisible();
      await expect(page.getByRole("row", { name: /^notes/ })).toBeVisible();
      await expect(page.getByRole("row", { name: /^assignee/ })).toHaveCount(0);
      // Denied means absent from the page entirely — the value a masked field held must never
      // render for a caller whose grant does not cover the field it lives in.
      await expect(page.getByText(CANARY)).toHaveCount(0);
    } finally {
      // Restore ana's grant to what dev-bootstrap left it as, for whatever runs after this file.
      const narrowed = await activeGrant(page, "ana", "matter_tasks");
      await regrant(page, narrowed, {
        requestFields: original.allowed_fields,
        allowedFields: original.allowed_fields,
        verbs: original.verbs,
        mode: original.mode,
      });
    }
  });
});
