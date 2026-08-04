import { test, expect, type Page } from "@playwright/test";
import { as, expectToast, resetEnv, selectOption } from "./helpers/auth";

// Per-document ACLs, driven the way they are actually used: a human restricts one document in the
// console, and a machine caller's reads change.
//
// The claim is not "a UI writes a row". It is that the row lands in the same `WHERE` every read
// goes through — so a `count` drops by exactly one, `getDocument` answers 404, and a filtered
// query returns nothing — while every other document in the collection stays where it was. That
// is only observable across two surfaces at once, which is why this is an e2e rather than a
// component test: the ACL is written through the session-cookie console and read through a Bearer
// token on `/v1`, with nothing shared between them but the database.
//
// `announcements` carries `acl: true` in examples/harbor/warehousd.yml and dev-bootstrap gives
// Mia an approved dev grant on it. Nothing here creates a document: the point is a count that
// moves by one against a population that already exists (harbor generates forty).

/** A headless key for Mia, exchanged for a token — the same path write-path.spec.ts uses. */
async function mintMiaToken(page: Page) {
  const keyRes = await page.request.post("/api/api-keys", {
    data: { name: `e2e-acl-robot-${Date.now()}`, mode: "headless", robotUserId: "mia" },
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

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function countAnnouncements(page: Page, token: string): Promise<number> {
  const res = await page.request.post("/v1/collections/announcements/query", {
    headers: bearer(token),
    data: { aggregate: [{ fn: "count", field: "id" }] },
  });
  expect(res.status()).toBe(200);
  const { documents } = await res.json();
  return Number(documents[0].count_id);
}

/**
 * The nth announcement id in a stable order.
 *
 * Each test takes its own document rather than sharing one. Tests run in file order against a
 * single database, so a shared subject would make a failure in the first test look like a bug in
 * the third — and the third is about authorization, not about cleanup.
 */
async function announcementId(page: Page, token: string, offset: number): Promise<string> {
  const res = await page.request.post("/v1/collections/announcements/query", {
    headers: bearer(token),
    data: { fields: ["id"], orderBy: { field: "id", dir: "asc" }, limit: 1, offset },
  });
  expect(res.status()).toBe(200);
  const { documents } = await res.json();
  expect(documents.length, `harbor seeds announcements; needed at least ${offset + 1}`).toBe(1);
  return documents[0].id as string;
}

/** Load one document's ACL in the console's Access tab. */
async function openAcl(page: Page, collection: string, documentId: string) {
  await page.goto(`/admin/collections/${collection}`);
  await page.getByRole("tab", { name: "Access" }).click();
  await page.getByLabel("Document id").fill(documentId);
  await page.getByRole("button", { name: "Load ACL", exact: true }).click();
}

test.describe("per-document ACLs", () => {
  test("restricting one document removes it from a caller's reads, and un-restricting brings it back", async ({
    page,
    context,
  }) => {
    await as(page, "admin");
    await resetEnv(context);
    const token = await mintMiaToken(page);

    const before = await countAnnouncements(page, token);
    expect(before, "harbor generates announcements to count against").toBeGreaterThan(1);
    const documentId = await announcementId(page, token, 0);

    // The console. Managing an ACL needs no grant — it is authorised by role, not by a grant verb,
    // which is the whole reason it cannot ride on `update`.
    await openAcl(page, "announcements", documentId);
    await expect(page.getByText("Public within the grant")).toBeVisible();

    // Restrict it to somebody who is not Mia.
    await page.getByLabel("User id").fill("ana");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expectToast(page, /Restricted to the listed principals/i);
    await expect(page.getByText("user:ana", { exact: true })).toBeVisible();

    // The count is the assertion this feature exists for: one lower, and not "the page is
    // shorter". A shortfall in a page would itself report how many documents the caller cannot
    // see; a scoped aggregate reports nothing.
    expect(await countAnnouncements(page, token)).toBe(before - 1);

    // Denied means absent, through every verb — not merely missing from an aggregate.
    const doc = await page.request.get(`/v1/collections/announcements/documents/${documentId}`, {
      headers: bearer(token),
    });
    expect(doc.status(), "getDocument on a restricted document is not_found").toBe(404);

    const filtered = await page.request.post("/v1/collections/announcements/query", {
      headers: bearer(token),
      data: { fields: ["id"], filters: [{ field: "id", op: "eq", value: documentId }] },
    });
    expect(filtered.status()).toBe(200);
    expect((await filtered.json()).documents).toHaveLength(0);

    // Un-restrict. An empty principal list removes the row, which is how a document becomes
    // public again — there is no separate "unrestrict" verb because there is nothing else it
    // could mean.
    await page.getByRole("button", { name: "Make public" }).click();
    await expectToast(page, /public again/i);
    expect(await countAnnouncements(page, token)).toBe(before);

    const back = await page.request.get(`/v1/collections/announcements/documents/${documentId}`, {
      headers: bearer(token),
    });
    expect(back.status()).toBe(200);
  });

  test("a group principal admits a caller through membership, and stops when membership does", async ({
    page,
    context,
  }) => {
    await as(page, "admin");
    await resetEnv(context);
    const token = await mintMiaToken(page);

    const before = await countAnnouncements(page, token);
    const documentId = await announcementId(page, token, 1);

    // Group membership is warehousd's own record, never a token claim. The console owns the
    // `manual` source; an SSO login owns `sso`, and neither overwrites the other.
    const joined = await page.request.put("/api/admin/users/mia/groups", {
      data: { groups: ["announcers"] },
    });
    expect(joined.status()).toBe(200);

    await openAcl(page, "announcements", documentId);
    await selectOption(page, "Principal", "group");
    await page.getByLabel("Group name").fill("announcers");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expectToast(page, /Restricted to the listed principals/i);
    await expect(page.getByText("group:announcers", { exact: true })).toBeVisible();

    // Restricted to a group Mia is in, so nothing disappears from her reads. That is the half of
    // the rule which fails in the direction nobody notices.
    expect(await countAnnouncements(page, token)).toBe(before);

    // Take her out of the group and the same ACL now excludes her. Principals are derived on
    // every call rather than baked into the token, so this needs no new token — the same rule
    // that makes grant revocation immediate.
    const left = await page.request.put("/api/admin/users/mia/groups", { data: { groups: [] } });
    expect(left.status()).toBe(200);
    expect(await countAnnouncements(page, token)).toBe(before - 1);

    await openAcl(page, "announcements", documentId);
    await page.getByRole("button", { name: "Make public" }).click();
    await expectToast(page, /public again/i);
    expect(await countAnnouncements(page, token)).toBe(before);
  });

  test("a REST client is refused unless its policy carries can_manage_acl", async ({
    page,
    context,
  }) => {
    await as(page, "admin");
    await resetEnv(context);
    const token = await mintMiaToken(page);
    const documentId = await announcementId(page, token, 2);

    // Mia's grant covers this collection and this document, so she can read it. Deciding who else
    // may read it is a different act, and her client was never given the flag.
    const refused = await page.request.put(
      `/v1/collections/announcements/documents/${documentId}/acl`,
      { headers: bearer(token), data: { principals: ["user:mia"] } },
    );
    expect(refused.status()).toBe(403);
    expect((await refused.json()).error).toBe("acl_denied");

    // A refused write writes nothing: the document is still reachable, and still unrestricted.
    const doc = await page.request.get(`/v1/collections/announcements/documents/${documentId}`, {
      headers: bearer(token),
    });
    expect(doc.status()).toBe(200);
  });

  test("managing an ACL takes the manager role, whatever the caller can read", async ({
    page,
    context,
  }) => {
    await as(page, "admin");
    await resetEnv(context);
    const token = await mintMiaToken(page);
    const documentId = await announcementId(page, token, 3);

    // Mia is a member holding an approved grant on this collection. The console route gates on
    // the role, not on the grant: being able to read a document says nothing about being allowed
    // to decide who else can.
    await as(page, "member");
    const res = await page.request.get(`/api/admin/collections/announcements/acl?id=${documentId}`);
    expect(res.status()).toBe(403);
  });

  test("the Access tab appears only where the collection declares acl: true", async ({
    page,
    context,
  }) => {
    await as(page, "admin");
    await resetEnv(context);

    await page.goto("/admin/collections/announcements");
    await expect(page.getByRole("tab", { name: "Access" })).toBeVisible();

    // `people` declares no `acl: true`, so its view has no `_acl` column — an editor there would
    // write rows nothing ever reads, which is worse than having no editor.
    await page.goto("/admin/collections/people");
    await expect(page.getByRole("tab", { name: "Data" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Access" })).toHaveCount(0);
  });
});
