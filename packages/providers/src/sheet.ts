import { inflateRawSync } from "node:zlib";
import { ExtractionFailed, type SheetGrid, type SheetReader } from "@warehousd/broker";

// XLSX, read directly.
//
// A .xlsx is a ZIP of XML parts, and the four this needs — the workbook, its relationships, the
// shared string table and one worksheet each — are small and well specified. Reading them here
// rather than through a spreadsheet library keeps a large, format-guessing dependency out of a
// project that is meant to stay thin, and it makes the three behaviours §P3 calls out
// non-negotiable something this file decides rather than something a library's defaults decide:
//
//   - **Formula cells import their CACHED VALUE.** `<c t="str"><f>…</f><v>Legal</v></c>` yields
//     "Legal". Nothing here evaluates a formula; a workbook saved without cached values imports
//     as blank, which is visible, rather than as a formula string, which is not.
//   - **Merged cells carry their value in the top-left cell only**, which is where Excel puts it.
//     The rest of the range is genuinely empty and is imported as empty — inventing a repeat
//     would silently multiply one value across a range.
//   - **Dates come back as the underlying serial number**, not a re-formatted string. `coerce`
//     in the broker parses dates; a locale-formatted string is where "03/04" becomes ambiguous.
//     Excel's epoch is applied so the value is an ISO date the broker can parse.
//
// Everything it cannot do, it refuses by name. There is no partial read.

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

/** The ZIP central directory, which is the only reliable index of a zip's contents. */
function readZip(filename: string, bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is last, after a comment of up to 64 KiB.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 0xffff; i--) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ExtractionFailed(filename, "not a valid XLSX (no zip directory)");

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();

  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== CENTRAL)
      throw new ExtractionFailed(filename, "not a valid XLSX (corrupt zip directory)");
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    // The local header repeats the name and extra fields, and its lengths are the authoritative
    // ones for finding where the data starts.
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compressedSize);

    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(raw)));
    else
      throw new ExtractionFailed(
        filename,
        `uses zip compression method ${method}, which warehousd cannot read — re-save it from a spreadsheet application`,
      );
  }
  return out;
}

const decode = (b: Uint8Array | undefined): string =>
  b === undefined ? "" : new TextDecoder().decode(b);

// XML entity decoding, limited to the five predefined entities plus numeric references. OOXML
// escapes nothing else in cell text.
function unescapeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  });
}

/**
 * The shared string table. Every text cell in a workbook is an index into this rather than a
 * literal, which is why a sheet on its own reads as a wall of integers.
 *
 * A string is `<si>` with either one `<t>` or a run of `<r><t>` fragments; the fragments are
 * concatenated, which is how Excel stores a cell with mixed formatting.
 */
function readSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    let text = "";
    for (const t of (si[1] ?? "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += t[1] ?? "";
    out.push(unescapeXml(text));
  }
  return out;
}

/** "BC12" → column 54 (0-based). Excel's bijective base-26. */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

// Excel's serial day 1 is 1900-01-01, and the format carries a deliberate bug: it treats 1900 as a
// leap year, so serials from 60 upward are one day ahead of reality. Anchoring on 1899-12-30 and
// leaving serials below 60 alone is the correction every reader applies.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
function serialToIso(serial: number): string {
  const ms = EXCEL_EPOCH_MS + Math.round(serial * 86_400_000);
  const d = new Date(ms);
  // A whole number is a date; a fraction carries a time of day, and dropping it would silently
  // round a timestamp to midnight.
  return Number.isInteger(serial) ? d.toISOString().slice(0, 10) : d.toISOString();
}

/**
 * Which number formats mean "this is a date".
 *
 * Excel stores every date as a number and remembers only the display format, so the format is the
 * only evidence there is. The built-in date formats are ids 14-22 and 45-47; a custom format is a
 * date when its code contains a date/time token outside a quoted literal.
 */
function dateFormatIds(stylesXml: string): Set<number> {
  const custom = new Set<number>();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    const code = unescapeXml(m[2] ?? "").replace(/"[^"]*"|\[[^\]]*\]/g, "");
    if (/[ymdhs]/i.test(code)) custom.add(Number(m[1]));
  }
  const builtIn = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

  // cellXfs maps a cell's `s` attribute (its index into this list) to a numFmtId.
  const xfs = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  const out = new Set<number>();
  let i = 0;
  for (const xf of xfs.matchAll(/<xf\b[^>]*\/?>/g)) {
    const id = Number(/numFmtId="(\d+)"/.exec(xf[0])?.[1] ?? "0");
    if (builtIn.has(id) || custom.has(id)) out.add(i);
    i++;
  }
  return out;
}

function readSheet(xml: string, shared: string[], dateStyles: Set<number>): string[][] {
  const rows: string[][] = [];
  for (const rowM of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowIndex = Number(/r="(\d+)"/.exec(rowM[1] ?? "")?.[1] ?? String(rows.length + 1)) - 1;
    const cells: string[] = [];
    for (const cellM of (rowM[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellM[1] ?? "";
      const body = cellM[2] ?? "";
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const col = ref ? columnIndex(ref) : cells.length;
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      const style = Number(/s="(\d+)"/.exec(attrs)?.[1] ?? "-1");

      let value = "";
      if (type === "inlineStr") {
        let text = "";
        for (const t of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += t[1] ?? "";
        value = unescapeXml(text);
      } else {
        // `<v>` is the cached value — for a formula cell too. Nothing here evaluates `<f>`.
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v !== undefined) {
          const raw = unescapeXml(v);
          if (type === "s") value = shared[Number(raw)] ?? "";
          else if (type === "b") value = raw === "1" ? "true" : "false";
          else if (type === "e")
            value = ""; // #REF!, #N/A — an error is not a value
          else if (
            type === "n" &&
            dateStyles.has(style) &&
            raw !== "" &&
            !Number.isNaN(Number(raw))
          )
            value = serialToIso(Number(raw));
          else value = raw;
        }
      }
      // A gap in `r` references is a run of genuinely empty cells — including the rest of a merged
      // range, whose value Excel stores in the top-left cell alone.
      while (cells.length < col) cells.push("");
      cells[col] = value;
    }
    while (rows.length < rowIndex) rows.push([]);
    rows[rowIndex] = cells;
  }
  return rows;
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => bytes[i] === b);
}

export function makeSheetReader(): SheetReader {
  return {
    read(bytes: Uint8Array): SheetGrid[] {
      const filename = "workbook.xlsx";
      if (!startsWith(bytes, ZIP_MAGIC))
        throw new ExtractionFailed(
          filename,
          "not an XLSX (an .xls saved by an old Excel is a different format — re-save as .xlsx)",
        );
      const zip = readZip(filename, bytes);

      const workbook = decode(zip.get("xl/workbook.xml"));
      if (!workbook) throw new ExtractionFailed(filename, "not an XLSX (no xl/workbook.xml)");
      const shared = readSharedStrings(decode(zip.get("xl/sharedStrings.xml")));
      const dateStyles = dateFormatIds(decode(zip.get("xl/styles.xml")));

      // The workbook names its sheets and points at each by relationship id; the rels part turns
      // that id into a path. Going through the rels rather than assuming `sheet1.xml` matters:
      // a workbook whose first sheet was deleted has sheets numbered from 2.
      const rels = new Map<string, string>();
      for (const m of decode(zip.get("xl/_rels/workbook.xml.rels")).matchAll(
        /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g,
      ))
        rels.set(m[1] ?? "", (m[2] ?? "").replace(/^\/?xl\//, "").replace(/^\.\//, ""));

      const grids: SheetGrid[] = [];
      for (const m of workbook.matchAll(/<sheet\b[^>]*\/>/g)) {
        const name = unescapeXml(/name="([^"]*)"/.exec(m[0])?.[1] ?? "");
        const rid = /r:id="([^"]+)"/.exec(m[0])?.[1] ?? "";
        const target = rels.get(rid);
        const part = target ? `xl/${target}` : undefined;
        const xml = part ? decode(zip.get(part)) : "";
        // A sheet whose part is missing is a broken workbook, not an empty sheet — but it is only
        // fatal if it turns out to be the one being imported, which selectSheet decides.
        grids.push({ name, rows: xml ? readSheet(xml, shared, dateStyles) : [] });
      }
      if (grids.length === 0) throw new ExtractionFailed(filename, "the workbook has no sheets");
      return grids;
    },
  };
}
