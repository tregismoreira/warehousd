import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExtractionFailed } from "@warehousd/broker";
import { makeBinaryExtractor } from "../src/extract-binary";

// The fixtures are generated rather than downloaded, and are the smallest valid files of their
// kind — a hand-built one-page PDF and a three-part DOCX zip. Both carry the same canary string,
// so "did extraction actually read the document" is one assertion.
const FIXTURES = join(__dirname, "fixtures");
const bytes = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const CANARY = "CANARY_PDF_BODY_3e6a";

const extractor = makeBinaryExtractor();

describe("what it extracts", () => {
  it("reads text out of a PDF", async () => {
    const out = await extractor.extract("sample.pdf", bytes("sample.pdf"));
    expect(out.text).toContain(CANARY);
    expect(out.pages).toBe(1);
  });

  it("reads text out of a DOCX, across paragraphs", async () => {
    const out = await extractor.extract("sample.docx", bytes("sample.docx"));
    expect(out.text).toContain(CANARY);
    expect(out.text).toContain("A second paragraph.");
  });

  it("declares the extensions it handles", () => {
    expect([...extractor.extensions].sort()).toEqual(["docx", "pdf"]);
  });

  it("is deterministic — the same bytes give the same text", async () => {
    // The indexer checksums the extracted text to decide whether to re-chunk and re-embed, so a
    // parser that varied between runs would re-embed the whole corpus on every index.
    const a = await extractor.extract("sample.pdf", bytes("sample.pdf"));
    const b = await extractor.extract("sample.pdf", bytes("sample.pdf"));
    expect(a.text).toBe(b.text);
  });
});

describe("what it refuses, and how", () => {
  // Every failure has to name the file and carry no parser internals: the indexer walks a
  // directory of hundreds and the operator needs to know which one, while pdf.js messages
  // describe document structure and are not something to surface.
  const failsWith = async (name: string, data: Uint8Array, match: RegExp) => {
    await expect(extractor.extract(name, data)).rejects.toThrow(ExtractionFailed);
    await expect(extractor.extract(name, data)).rejects.toThrow(match);
    await expect(extractor.extract(name, data)).rejects.toThrow(
      new RegExp(name.replace(".", "\\.")),
    );
  };

  it("an empty file", async () => {
    await failsWith("empty.pdf", new Uint8Array(0), /empty/i);
  });

  it("a .pdf that is not a PDF", async () => {
    await failsWith("not-really.pdf", bytes("not-really.pdf"), /not a PDF/i);
  });

  it("a .docx that is not a zip — the old .doc format, most often", async () => {
    // OLE2 magic: what Word 97-2003 actually writes. The message has to say what to do about it.
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    await failsWith("old.docx", ole, /re-save as \.docx/i);
  });

  it("a truncated PDF", async () => {
    const half = bytes("sample.pdf").slice(0, 40);
    await expect(extractor.extract("half.pdf", half)).rejects.toThrow(ExtractionFailed);
  });

  it("an extension it does not handle", async () => {
    await failsWith("notes.rtf", new Uint8Array([1, 2, 3]), /unsupported extension/i);
  });

  it("a PDF with no extractable text — a scan needs OCR, not silent success", async () => {
    // A valid PDF with no text operators parses fine and yields "". Indexing that would create a
    // document nothing can ever find, which looks like success and is not.
    const blank = new TextEncoder().encode(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n" +
        "trailer\n<< /Size 4 /Root 1 0 R >>\n%%EOF\n",
    );
    await expect(extractor.extract("scan.pdf", blank)).rejects.toThrow(/OCR|no extractable text/i);
  });

  it("never leaks parser internals into the message", async () => {
    // The thrown message is what an operator sees and what reaches a log line. It should name the
    // file and the problem — nothing about xref tables, object streams or stack frames.
    const err = await extractor
      .extract("not-really.pdf", bytes("not-really.pdf"))
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ExtractionFailed);
    expect((err as Error).message).not.toMatch(/xref|stream|worker|pdf\.js|at Object|\.mjs/i);
  });
});
