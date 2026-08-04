import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { as, selectOption, expectToast } from "./helpers/auth";

// The upload queue, driven by a real browser.
//
// Everything below this page is already covered without one — the routes in
// apps/web/test/admin-documents.integration.test.ts, the ingestion in
// packages/broker/test/upload.integration.test.ts. What only a browser can prove is the part
// that is the actual feature: files are hashed *in the browser* with WebCrypto, the plan comes
// back before anything is sent, and what the plan says is already stored is not sent at all.
// That is the resume story, and it is a claim about the client.
//
// `precedents` rather than `policies`: it is a file collection with the same two bound
// vocabularies, and no other spec reads its documents. Uploads land in the environment the
// header's switcher names, which is `dev` unless a test changes it — `data_synth`, rebuilt by
// scripts/e2e-setup.ts on every run.
const COLLECTION = "precedents";

const FIXTURES = resolve(fileURLToPath(import.meta.url), "../fixtures/upload");

/** A body unique per test, so a re-run of the suite never plans against its own leftovers. */
const unique = () => `# E2E ${Date.now()}-${Math.random().toString(36).slice(2)}\n\nBody.`;

// The pickers are hidden inputs driven by real buttons, so they are addressed by their
// aria-label rather than by clicking — a browser will not let a test answer a native file dialog.
const fileInput = (page: Page, which: "Choose files" | "Choose a folder") => page.getByLabel(which);

async function chooseCollection(page: Page) {
  await selectOption(page, "Collection", new RegExp(`^${COLLECTION}$`));
  // Both vocabularies are required, and the Upload button stays disabled until they are set.
  await selectOption(page, "Department", "HR");
  await selectOption(page, "Tags", "Compliance");
}

/** The queue reaches a settled state when nothing is queued and nothing is uploading. */
const uploadedCount = (page: Page) => page.getByText(/^\d+ uploaded$/);

test.describe("document upload", () => {
  test.beforeEach(async ({ page }) => {
    await as(page, "admin");
    await page.goto("/admin/documents");
  });

  test("the page names the environment it will write to, and offers no second selector", async ({
    page,
  }) => {
    // A page with its own env picker would offer dev's vocabulary terms while uploading into
    // live. The switcher in the header is the one environment concept.
    await expect(page.getByText(/Uploading into\s*dev/)).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Environment" })).toHaveCount(0);
  });

  test("picking a collection asks for the terms its bound vocabularies require", async ({
    page,
  }) => {
    await selectOption(page, "Collection", new RegExp(`^${COLLECTION}$`));
    await expect(page.getByLabel("Department")).toBeVisible();
    await expect(page.getByLabel("Tags")).toBeVisible();
    // The metadata fields `precedents` declares, rendered from the collection's own config.
    await expect(page.getByLabel(/jurisdiction/)).toBeVisible();
  });

  test("files cannot be chosen before a collection is", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Select files" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Select a folder" })).toBeDisabled();
  });

  test("a batch is hashed, planned and uploaded, and the queue reports each file", async ({
    page,
  }) => {
    await chooseCollection(page);

    // The plan request is what proves the client hashed before sending anything: it carries a
    // 64-character hex digest per file, computed in the browser, and it happens *first*.
    const planned = page.waitForRequest(
      (r) => r.url().includes("/api/admin/documents/plan") && r.method() === "POST",
    );
    const body = unique();
    await fileInput(page, "Choose files").setInputFiles([
      { name: "e2e-alpha.md", mimeType: "text/markdown", buffer: Buffer.from(body) },
      { name: "e2e-beta.md", mimeType: "text/markdown", buffer: Buffer.from(unique()) },
    ]);
    const files = (await (await planned).postDataJSON()) as {
      files: { path: string; checksum: string }[];
    };
    expect(files.files).toHaveLength(2);
    for (const f of files.files) expect(f.checksum).toMatch(/^[0-9a-f]{64}$/);

    await expect(page.getByRole("button", { name: "Upload 2 file(s)" })).toBeEnabled();
    await page.getByRole("button", { name: "Upload 2 file(s)" }).click();

    await expectToast(page, "Upload complete");
    await expect(uploadedCount(page)).toHaveText("2 uploaded");
    await expect(page.getByText("e2e-alpha.md")).toBeVisible();
  });

  test("re-selecting the same files uploads nothing — this is the resume", async ({ page }) => {
    await chooseCollection(page);
    const body = unique();
    const pick = () =>
      fileInput(page, "Choose files").setInputFiles([
        { name: "e2e-resume.md", mimeType: "text/markdown", buffer: Buffer.from(body) },
      ]);

    await pick();
    await page.getByRole("button", { name: "Upload 1 file(s)" }).click();
    await expect(uploadedCount(page)).toHaveText("1 uploaded");

    // Second pass, same bytes. Nothing about this depends on what the page remembers — the
    // answer comes from the database — so an interrupted upload resumes the same way, from a
    // different tab or a different machine.
    const uploads: string[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/admin/documents") && r.method() === "POST") uploads.push(r.url());
    });

    await pick();
    await expect(page.getByText("1 already stored")).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload 0 file(s)" })).toBeDisabled();
    expect(uploads).toHaveLength(0);
  });

  test("a folder keeps the path each file came in with", async ({ page }) => {
    await chooseCollection(page);
    // Playwright populates webkitRelativePath for a directory, which is the only way to check
    // that a nested file does not arrive as a bare filename — two `onboarding.md` in different
    // folders would then be one document overwriting the other.
    await fileInput(page, "Choose a folder").setInputFiles(FIXTURES);

    // The `.png` in the fixture directory is not an accepted type and never reaches a request.
    await expectToast(page, /1 file\(s\) skipped/);
    await expect(page.getByText("upload/handbook/onboarding.md")).toBeVisible();
    await expect(page.getByText("upload/retention.md")).toBeVisible();
    await expect(page.getByText("scan.png")).toHaveCount(0);

    await page.getByRole("button", { name: /^Upload \d+ file\(s\)$/ }).click();
    await expectToast(page, "Upload complete");
  });

  test("the upload button stays disabled until every bound vocabulary has a term", async ({
    page,
  }) => {
    // An unscoped document would be reachable by a grant approved on the assumption it carried
    // a term. The route refuses one too; this is the half that says so before you press it.
    await selectOption(page, "Collection", new RegExp(`^${COLLECTION}$`));
    await fileInput(page, "Choose files").setInputFiles([
      { name: "e2e-no-term.md", mimeType: "text/markdown", buffer: Buffer.from(unique()) },
    ]);
    await expect(page.getByRole("button", { name: "Upload 1 file(s)" })).toBeDisabled();
    await expect(page.getByText(/every document needs a term from it/)).toBeVisible();

    await selectOption(page, "Department", "HR");
    await selectOption(page, "Tags", "Compliance");
    await expect(page.getByRole("button", { name: "Upload 1 file(s)" })).toBeEnabled();
  });

  test("an uploaded document is findable in the collection's own data browser", async ({
    page,
  }) => {
    // The end of the arc: a file chosen in a browser becomes a document the governed read path
    // returns, under the same grant as anything indexed from disk.
    await chooseCollection(page);
    const marker = `E2E-SEARCHABLE-${Date.now()}`;
    await fileInput(page, "Choose files").setInputFiles([
      {
        name: "e2e-searchable.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(`# Searchable\n\n${marker} appears in this document.`),
      },
    ]);
    await page.getByRole("button", { name: "Upload 1 file(s)" }).click();
    await expectToast(page, "Upload complete");

    await page.goto(`/admin/collections/${COLLECTION}`);
    await page.getByRole("tab", { name: "Files" }).click();
    await expect(page.getByText("Searchable")).toBeVisible();
  });
});
