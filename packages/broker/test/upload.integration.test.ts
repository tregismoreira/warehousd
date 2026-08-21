import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { provision, testPool, type Provisioned } from "./helpers/db";
import { createAppSchema, DEFAULT_WORKSPACE_ID } from "../src/db/migrate-app";
import { applyConfig } from "../src/apply/apply";
import { ConfigSchema } from "../src/config/schema";
import { indexCollection } from "../src/indexing";
import { planUpload, uploadFile, deleteUploadedFile, readFileBlob } from "../src/indexing/upload";
import { blobChecksum } from "../src/indexing/upload";
import { loadTaxonomyBindings } from "../src/taxonomy";
import type { BinaryExtractor } from "../src/providers";

// Uploading a corpus through the browser rather than from disk.
//
// Two claims are under test and neither is obvious from reading the route:
//
//  1. **An upload is indistinguishable from an indexed file downstream.** Same chunking, same
//     checksum semantics, same required-term rule. If the two paths could drift, a document's
//     reachability would depend on how it arrived — which is not a thing a governed layer may
//     have. So `ingestFile` is shared, and the parity assertion below is what keeps it shared.
//  2. **Resume is answered by the database, not by the client.** `planUpload` is the entire
//     mechanism, and it has to stay correct when the client remembers nothing at all.

const MAX = 25 * 1024 * 1024;

const cfg = ConfigSchema.parse({
  project: "t",
  server: { port: 1 },
  synthetic: { documents_per_collection: {} },
  taxonomies: {
    category: { label: "C", terms: { hr: { label: "HR" }, finance: { label: "Fin" } } },
  },
  collections: {
    notes: {
      type: "file" as const,
      description: "d",
      source: "./x",
      fields: {
        title: { posture: "allow" as const },
        content: { posture: "allow" as const },
        path: { posture: "deny" as const },
      },
    },
    policies: {
      type: "file" as const,
      description: "d",
      source: "./x",
      taxonomies: ["category"],
      fields: {
        title: { posture: "allow" as const },
        content: { posture: "allow" as const },
        path: { posture: "deny" as const },
      },
    },
  },
});

let p: Provisioned;
let db: Pool;
let bindings: Awaited<ReturnType<typeof loadTaxonomyBindings>>;
// A stub extractor, the way the semantic suites stub the embedder: `packages/broker` declares
// the interface and never imports the real PDF parser, so a test of the broker must not either.
// It still checks the magic bytes, because "a PDF renamed .md, and the reverse" is one of the
// things this file is asserting about, and a stub that accepted anything would assert nothing.
const extractor: BinaryExtractor = {
  extensions: ["pdf", "docx"],
  extract(filename, bytes) {
    if (!Buffer.from(bytes).subarray(0, 5).equals(Buffer.from("%PDF-")))
      return Promise.reject(new Error(`${filename}: not a PDF`));
    return Promise.resolve({ text: `Extracted from ${filename}. ${PDF_BODY}`, title: "Sample" });
  },
};
const PDF_BODY = "The quick brown fox reviewed the retention schedule.";
// Distinct byte streams that both extract to the same text — which is exactly the case the two
// checksums have to tell apart.
const pdfBytes = (tail = "a") => Buffer.from(`%PDF-1.4\n${tail}\n%%EOF\n`, "latin1");

const md = (body: string) => Buffer.from(body, "utf8");

async function put(
  collection: string,
  path: string,
  bytes: Buffer,
  extra: Record<string, unknown> = {},
) {
  return uploadFile(
    db,
    "dev",
    collection,
    DEFAULT_WORKSPACE_ID,
    { path, bytes, maxBytes: MAX, ...extra },
    { extractor, ...(collection === "policies" ? { taxonomies: bindings } : {}) },
  );
}

beforeAll(async () => {
  p = await provision("upload");
  db = testPool({ connectionString: p.urls.admin });
  await createAppSchema(db);
  await applyConfig(db, cfg);
  bindings = await loadTaxonomyBindings(db, cfg, "policies", "dev", DEFAULT_WORKSPACE_ID);
}, 120_000);

afterAll(async () => {
  await db?.end();
  await p?.end();
});

beforeEach(async () => {
  await db.query(`delete from data_synth."notes__files"`);
  await db.query(`delete from data_synth."policies__files"`);
});

describe("planUpload — the whole of resume", () => {
  it("reports new, unchanged and changed against the stored bytes", async () => {
    const bytes = md("# A\n\nAlpha.");
    await put("notes", "a.md", bytes);

    const plan = await planUpload(db, "dev", "notes", DEFAULT_WORKSPACE_ID, [
      { path: "a.md", checksum: blobChecksum(bytes) },
      { path: "a.md", checksum: blobChecksum(md("# A\n\nEdited.")) },
      { path: "never-seen.md", checksum: blobChecksum(md("x")) },
    ]);
    expect(plan).toEqual([
      { path: "a.md", status: "unchanged" },
      { path: "a.md", status: "changed" },
      { path: "never-seen.md", status: "new" },
    ]);
  });

  it("answers from the database, so a client that remembers nothing still resumes", async () => {
    // The failure this guards against: a resume that depends on localStorage silently
    // re-uploads a whole corpus from a second machine, or — worse — skips files it never sent.
    const files = Array.from({ length: 5 }, (_, i) => ({
      path: `d/${i}.md`,
      bytes: md(`# ${i}\n\nBody ${i}.`),
    }));
    for (const f of files.slice(0, 3)) await put("notes", f.path, f.bytes);

    const plan = await planUpload(
      db,
      "dev",
      "notes",
      DEFAULT_WORKSPACE_ID,
      files.map((f) => ({ path: f.path, checksum: blobChecksum(f.bytes) })),
    );
    expect(plan.filter((x) => x.status === "unchanged")).toHaveLength(3);
    expect(plan.filter((x) => x.status === "new")).toHaveLength(2);
  });

  it("costs nothing on an empty list and does not go to the database", async () => {
    expect(await planUpload(db, "dev", "notes", DEFAULT_WORKSPACE_ID, [])).toEqual([]);
  });

  it("matches on the stored bytes, not on the extracted text", async () => {
    // The two hashes are deliberately different things: `checksum` is over the extracted text
    // (so two exports of one PDF do not re-chunk), `blob_checksum` is over the bytes (so the
    // client can compute it before uploading). Confusing them would make the plan always say
    // `changed` for a PDF, and the corpus would re-upload in full every session.
    const bytes = pdfBytes();
    await put("notes", "s.pdf", bytes);
    const row = await db.query<{ checksum: string; blob_checksum: string }>(
      `select checksum, blob_checksum from data_synth."notes__files" where path='s.pdf'`,
    );
    expect(row.rows[0]!.blob_checksum).toBe(blobChecksum(bytes));
    expect(row.rows[0]!.checksum).not.toBe(row.rows[0]!.blob_checksum);
    expect(
      await planUpload(db, "dev", "notes", DEFAULT_WORKSPACE_ID, [
        { path: "s.pdf", checksum: blobChecksum(bytes) },
      ]),
    ).toEqual([{ path: "s.pdf", status: "unchanged" }]);
  });
});

describe("uploadFile", () => {
  it("stores, chunks and reports the file it created", async () => {
    const r = await put("notes", "a.md", md("# Title\n\nBody text."));
    expect(r).toMatchObject({ ok: true, status: "indexed", title: "Title", path: "a.md" });
    const chunks = await db.query(`select count(*)::int n from data_synth."notes__documents"`);
    expect(chunks.rows[0].n).toBeGreaterThan(0);
  });

  it("revises rather than duplicates when the same path arrives again", async () => {
    await put("notes", "a.md", md("# Title\n\nFirst."));
    const second = await put("notes", "a.md", md("# Title\n\nSecond."));
    expect(second).toMatchObject({ ok: true, status: "indexed" });
    const rows = await db.query(`select id from data_synth."notes__files" where path='a.md'`);
    expect(rows.rowCount).toBe(1);
    const docs = await db.query<{ content: string }>(
      `select content from data_synth."notes__documents"`,
    );
    // Chunks are replaced, never appended: a stale chunk would keep answering searches with
    // the pre-edit text.
    expect(docs.rows.map((d) => d.content).join(" ")).toContain("Second");
    expect(docs.rows.map((d) => d.content).join(" ")).not.toContain("First");
  });

  it("skips identical content without rewriting anything", async () => {
    await put("notes", "a.md", md("# Title\n\nSame."));
    const again = await put("notes", "a.md", md("# Title\n\nSame."));
    expect(again).toMatchObject({ ok: true, status: "skipped" });
  });

  it("refuses an unsupported type, an empty file and one over the cap", async () => {
    expect(await put("notes", "photo.png", md("x"))).toMatchObject({
      ok: false,
      reason: "unsupported_type",
    });
    expect(await put("notes", "a.md", Buffer.alloc(0))).toMatchObject({
      ok: false,
      reason: "empty",
    });
    expect(
      await uploadFile(db, "dev", "notes", DEFAULT_WORKSPACE_ID, {
        path: "a.md",
        bytes: md("hello there"),
        maxBytes: 4,
      }),
    ).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("refuses a file whose bytes do not match the checksum the client claimed", async () => {
    // Believing the claim would poison the plan for every later session: the row would carry a
    // checksum matching bytes that were never stored, and every future upload of the real file
    // would come back `unchanged` and be skipped. That is precisely "we lost files".
    const r = await put("notes", "a.md", md("# A\n\nReal."), {
      checksum: blobChecksum(md("something else")),
    });
    expect(r).toMatchObject({ ok: false, reason: "checksum_mismatch" });
    expect(
      (await db.query(`select 1 from data_synth."notes__files" where path='a.md'`)).rowCount,
    ).toBe(0);
  });

  it("extracts a PDF and stores the original bytes beside the text", async () => {
    const bytes = pdfBytes();
    const r = await put("notes", "sample.pdf", bytes);
    expect(r).toMatchObject({ ok: true, status: "indexed" });
    const row = await db.query<{ content_type: string; byte_size: number; blob: Buffer }>(
      `select content_type, byte_size, blob from data_synth."notes__files" where path='sample.pdf'`,
    );
    expect(row.rows[0]!.content_type).toBe("application/pdf");
    expect(row.rows[0]!.byte_size).toBe(bytes.byteLength);
    expect(Buffer.compare(row.rows[0]!.blob, bytes)).toBe(0);
  });

  it("dispatches on the extension, not on anything the caller declared", async () => {
    // A PDF renamed `.md` must not be read as text — it would store mojibake as a document and
    // the admin would have no way to tell.
    const r = await put("notes", "actually.pdf", md("this is plainly not a pdf"));
    expect(r.ok).toBe(false);
  });
});

describe("the required-term rule holds on this surface too", () => {
  it("refuses a binary with no term for a bound vocabulary", async () => {
    const r = await put("policies", "s.pdf", pdfBytes());
    expect(r).toMatchObject({ ok: false, reason: "rejected" });
    if (r.ok) throw new Error("unreachable");
    expect(r.detail).toMatch(/missing required category/);
  });

  it("refuses an unknown term rather than storing it", async () => {
    const r = await put("policies", "s.pdf", pdfBytes(), {
      sidecar: { category: "not-a-term" },
    });
    expect(r).toMatchObject({ ok: false, reason: "rejected" });
  });

  it("accepts the term from the form, exactly as it would from a sidecar file", async () => {
    const r = await put("policies", "s.pdf", pdfBytes(), {
      sidecar: { category: "hr", owner: "ana@harbor.demo" },
    });
    expect(r.ok).toBe(true);
    const row = await db.query<{ category: string; owner: string }>(
      `select category, owner from data_synth."policies__files" where path='s.pdf'`,
    );
    expect(row.rows[0]).toMatchObject({ category: "hr", owner: "ana@harbor.demo" });
  });
});

describe("uploads and directory indexing coexist", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wh-upl-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a later index does not delete an uploaded document", async () => {
    // The sweep at the end of indexCollection deletes what is no longer in the source directory.
    // An uploaded file was never in one. Without `origin` the first index after an upload would
    // silently destroy it, and nothing would say so.
    await put("notes", "uploaded.md", md("# Uploaded\n\nBody."));
    writeFileSync(join(dir, "from-disk.md"), "# Disk\n\nBody.");
    const r = await indexCollection(db, "dev", "notes", dir, DEFAULT_WORKSPACE_ID);
    expect(r.deleted).toBe(0);
    const paths = await db.query<{ path: string }>(
      `select path from data_synth."notes__files" order by path`,
    );
    expect(paths.rows.map((x) => x.path)).toEqual(["from-disk.md", "uploaded.md"]);
  });

  it("still sweeps a file that left the source directory", async () => {
    writeFileSync(join(dir, "a.md"), "# A\n\nBody.");
    await indexCollection(db, "dev", "notes", dir, DEFAULT_WORKSPACE_ID);
    rmSync(join(dir, "a.md"));
    expect((await indexCollection(db, "dev", "notes", dir, DEFAULT_WORKSPACE_ID)).deleted).toBe(1);
  });

  it("produces the same stored row whichever path a file arrives by", async () => {
    // The parity assertion. If these ever diverge, one of the two paths has grown a rule the
    // other does not have — and which one applies would depend on how the file was uploaded.
    const body = "---\nowner: ana@harbor.demo\n---\n# Parity\n\nIdentical body text.";
    writeFileSync(join(dir, "same.md"), body);
    await indexCollection(db, "dev", "notes", dir, DEFAULT_WORKSPACE_ID);
    const indexed = (
      await db.query(
        `select title, owner, checksum from data_synth."notes__files" where path='same.md'`,
      )
    ).rows[0];
    const indexedChunks = (
      await db.query<{ content: string }>(
        `select content from data_synth."notes__documents" c
           join data_synth."notes__files" f on f.id = c.file_id
          where f.path='same.md' order by document_seq`,
      )
    ).rows.map((r) => r.content);

    await put("notes", "same-uploaded.md", md(body));
    const uploaded = (
      await db.query(
        `select title, owner, checksum from data_synth."notes__files" where path='same-uploaded.md'`,
      )
    ).rows[0];
    const uploadedChunks = (
      await db.query<{ content: string }>(
        `select content from data_synth."notes__documents" c
           join data_synth."notes__files" f on f.id = c.file_id
          where f.path='same-uploaded.md' order by document_seq`,
      )
    ).rows.map((r) => r.content);

    expect(uploaded.title).toBe(indexed.title);
    expect(uploaded.owner).toBe(indexed.owner);
    expect(uploaded.checksum).toBe(indexed.checksum);
    expect(uploadedChunks).toEqual(indexedChunks);
  });
});

describe("delete and raw download", () => {
  it("removes the file and its chunks, and reports the path it removed", async () => {
    const r = await put("notes", "gone.md", md("# Gone\n\nBody."));
    if (!r.ok) throw new Error("unreachable");
    const del = await deleteUploadedFile(db, "dev", "notes", DEFAULT_WORKSPACE_ID, r.fileId);
    expect(del).toEqual({ deleted: true, path: "gone.md" });
    expect(
      (await db.query(`select 1 from data_synth."notes__documents" where file_id=$1`, [r.fileId]))
        .rowCount,
    ).toBe(0);
  });

  it("reports a miss rather than pretending", async () => {
    const del = await deleteUploadedFile(
      db,
      "dev",
      "notes",
      DEFAULT_WORKSPACE_ID,
      "00000000-0000-4000-8000-000000000000",
    );
    expect(del).toEqual({ deleted: false, path: null });
  });

  it("returns the original bytes byte for byte", async () => {
    const bytes = pdfBytes();
    const r = await put("notes", "raw.pdf", bytes);
    if (!r.ok) throw new Error("unreachable");
    const stored = await readFileBlob(db, "dev", "notes", DEFAULT_WORKSPACE_ID, r.fileId);
    expect(stored).not.toBeNull();
    expect(Buffer.compare(stored!.bytes, bytes)).toBe(0);
    expect(stored!.contentType).toBe("application/pdf");
  });
});
