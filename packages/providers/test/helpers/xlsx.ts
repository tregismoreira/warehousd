import { deflateRawSync, crc32 } from "node:zlib";

// A minimal XLSX writer, for fixtures.
//
// The reader under test parses a real workbook, so the fixtures have to be real workbooks — a
// hand-rolled byte string would only prove the reader agrees with itself. This writes the same
// four parts Excel writes, using stored-string cells, a shared string table, a date style and a
// formula cell with a cached value, so each of the behaviours §P3 pins down has something to
// parse.

type Cell = { v: string; type: "s" | "n" | "inline" | "formula" | "date" | "blank" };

export type SheetSpec = {
  name: string;
  /**
   * Rows of cells. `null` is a genuinely absent cell — which is what the rest of a merged range
   * is, and what a sparse sheet's gaps are. The writer omits it from the XML entirely, exactly as
   * Excel does, rather than writing an empty `<c/>`.
   */
  rows: (Cell | null)[][];
};

export const text = (v: string): Cell => ({ v, type: "s" });
export const inline = (v: string): Cell => ({ v, type: "inline" });
export const num = (v: number): Cell => ({ v: String(v), type: "n" });
export const date = (serial: number): Cell => ({ v: String(serial), type: "date" });
/** A formula cell: the formula is never evaluated, so what matters is the cached `<v>`. */
export const formula = (cached: string): Cell => ({ v: cached, type: "formula" });

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function colRef(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - r) / 26);
  }
  return s;
}

export function buildXlsx(sheets: SheetSpec[]): Uint8Array {
  const shared: string[] = [];
  const sharedIndex = (v: string) => {
    const i = shared.indexOf(v);
    if (i >= 0) return i;
    shared.push(v);
    return shared.length - 1;
  };

  const sheetXml = sheets.map((sheet) => {
    const rows = sheet.rows
      .map((cells, r) => {
        const body = cells
          .map((c, i) => {
            if (c === null) return "";
            const ref = `${colRef(i)}${r + 1}`;
            if (c.type === "inline")
              return `<c r="${ref}" t="inlineStr"><is><t>${esc(c.v)}</t></is></c>`;
            if (c.type === "s") return `<c r="${ref}" t="s"><v>${sharedIndex(c.v)}</v></c>`;
            // Style 1 is the date format declared in styles.xml below.
            if (c.type === "date") return `<c r="${ref}" s="1"><v>${c.v}</v></c>`;
            if (c.type === "formula")
              return `<c r="${ref}" t="str"><f>UPPER(A1)</f><v>${esc(c.v)}</v></c>`;
            return `<c r="${ref}"><v>${esc(c.v)}</v></c>`;
          })
          .join("");
        return body ? `<row r="${r + 1}">${body}</row>` : "";
      })
      .join("");
    return `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;
  });

  const sharedXml = `<?xml version="1.0"?><sst count="${shared.length}" uniqueCount="${shared.length}">${shared
    .map((v) => `<si><t>${esc(v)}</t></si>`)
    .join("")}</sst>`;

  // numFmtId 14 is the built-in short date; cellXfs index 1 points at it.
  const stylesXml = `<?xml version="1.0"?><styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`;

  const workbookXml = `<?xml version="1.0"?><workbook><sheets>${sheets
    .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("")}</sheets></workbook>`;

  const relsXml = `<?xml version="1.0"?><Relationships>${sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join("")}</Relationships>`;

  const files: [string, string][] = [
    ["xl/workbook.xml", workbookXml],
    ["xl/_rels/workbook.xml.rels", relsXml],
    ["xl/sharedStrings.xml", sharedXml],
    ["xl/styles.xml", stylesXml],
    ...sheetXml.map((xml, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, xml]),
  ];
  return zip(files);
}

// A deflate-compressed zip with a central directory — the only shape the reader accepts.
function zip(files: [string, string][]): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of files) {
    const raw = Buffer.from(content, "utf8");
    const deflated = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, deflated);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  }

  const dir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return new Uint8Array(Buffer.concat([...chunks, dir, eocd]));
}
