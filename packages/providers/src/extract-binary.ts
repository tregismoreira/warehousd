import { ExtractionFailed, type BinaryExtractor, type ExtractedText } from "@warehousd/broker";
// Imported statically. Both resolve under CommonJS — unpdf ships a `require` condition and
// mammoth is CommonJS outright — so bundling them into the CLI works, unlike the ESM-only
// embedding runtime next door which has to stay opaque to the bundler (see runtime-import.ts).
import { getDocumentProxy, extractText as extractTextFrom, getMeta } from "unpdf";
import mammoth from "mammoth";

// PDF and DOCX text extraction.
//
// Every failure becomes an ExtractionFailed naming the file. A parser's own error is not something
// a caller should see — pdf.js in particular puts document structure in its messages — and the
// indexer needs to be able to say which file in a directory of two hundred was the bad one.

const PDF_MAGIC = "%PDF-";
// DOCX is a zip: "PK\x03\x04". A .docx that is really a .doc (OLE2) fails this and gets a useful
// message rather than a zip-parser stack trace forty frames deep.
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => bytes[i] === b);
}

async function extractPdf(filename: string, bytes: Uint8Array): Promise<ExtractedText> {
  if (!new TextDecoder().decode(bytes.subarray(0, 5)).startsWith(PDF_MAGIC))
    throw new ExtractionFailed(filename, "not a PDF (missing %PDF- header)");
  try {
    const doc = await getDocumentProxy(bytes);
    const { text, totalPages } = await extractTextFrom(doc, { mergePages: true });
    const meta = await getMeta(doc).catch(() => null);
    // `info.Title` is frequently the authoring tool's placeholder rather than the document's
    // title, so an empty or whitespace-only one is treated as absent and the indexer falls back
    // to the filename — the same rule extract.ts already applies to markdown without a heading.
    const title = typeof meta?.info?.Title === "string" ? meta.info.Title.trim() : "";
    return {
      text: typeof text === "string" ? text : String(text),
      ...(title ? { title } : {}),
      pages: totalPages,
    };
  } catch (err) {
    if (err instanceof ExtractionFailed) throw err;
    throw new ExtractionFailed(filename, "could not be parsed as a PDF");
  }
}

async function extractDocx(filename: string, bytes: Uint8Array): Promise<ExtractedText> {
  if (!startsWith(bytes, ZIP_MAGIC))
    throw new ExtractionFailed(
      filename,
      "not a DOCX (a .doc saved by an old Word is a different format — re-save as .docx)",
    );
  try {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return { text: value };
  } catch {
    throw new ExtractionFailed(filename, "could not be parsed as a DOCX");
  }
}

export function makeBinaryExtractor(): BinaryExtractor {
  return {
    extensions: ["pdf", "docx"],
    async extract(filename, bytes) {
      if (bytes.byteLength === 0) throw new ExtractionFailed(filename, "file is empty");
      const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
      const out =
        ext === "pdf"
          ? await extractPdf(filename, bytes)
          : ext === "docx"
            ? await extractDocx(filename, bytes)
            : null;
      if (!out) throw new ExtractionFailed(filename, `unsupported extension ".${ext}"`);
      // A PDF of scanned pages parses fine and yields nothing. Indexing it would create a
      // document that can never be found, so say so instead — OCR is out of scope, and silently
      // storing an empty document is the failure mode that looks like success.
      if (!out.text.trim())
        throw new ExtractionFailed(
          filename,
          "no extractable text (a scanned or image-only document needs OCR first)",
        );
      return out;
    },
  };
}
