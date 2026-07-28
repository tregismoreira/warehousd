import { createHash } from "node:crypto";
import { basename } from "node:path";

// One entry per vocabulary bound to the collection. `multiple` decides whether the
// frontmatter value parses as a list (string[]) or a scalar (string).
export type TermField = { field: string; multiple?: boolean };

// One entry per metadata field (typed extra fields on file collections).
export type MetadataField = { field: string; type: "text" | "date" | "timestamptz" | "numeric" | "int" | "boolean" };

export type ExtractedFile = {
  path: string; title: string; owner: string | null;
  // Exactly one key per requested term field. A requested field absent from the
  // frontmatter is `null` — never `undefined` — so callers can tell "not asked for"
  // (key missing) from "asked for, not present" (null).
  terms: Record<string, string | string[] | null>;
  // Metadata fields: value if present and coercible, null if missing, throws if uncoercible.
  metadata: Record<string, string | number | boolean | null>;
  updatedAt: Date; content: string; checksum: string;
};

// `tags: [a, b]` or `tags: a, b` for a multi-value vocabulary; a bare scalar for a
// single-value one. Trailing/leading whitespace and empty entries are dropped.
function parseTermValue(relPath: string, tf: TermField, raw: string): string | string[] {
  const bracketed = raw.startsWith("[") && raw.endsWith("]");
  const body = bracketed ? raw.slice(1, -1) : raw;
  const parts = body.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (tf.multiple) return parts;
  if (bracketed || parts.length > 1)
    throw new Error(`${relPath}: ${tf.field} is a single-value vocabulary and may not hold a list`);
  return parts[0] ?? "";
}

// Coerce a string value to its declared type. Throws if coercion fails, naming the file.
function coerceMetadataValue(relPath: string, mf: MetadataField, raw: string): string | number | boolean {
  const trimmed = raw.trim();
  switch (mf.type) {
    case "text":
      return trimmed;
    case "int": {
      const n = Number(trimmed);
      if (!Number.isInteger(n)) throw new Error(`${relPath}: field "${mf.field}" expected integer, got "${trimmed}"`);
      return n;
    }
    case "numeric": {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) throw new Error(`${relPath}: field "${mf.field}" expected number, got "${trimmed}"`);
      return n;
    }
    case "boolean": {
      const lower = trimmed.toLowerCase();
      if (["true", "t", "1", "yes"].includes(lower)) return true;
      if (["false", "f", "0", "no"].includes(lower)) return false;
      throw new Error(`${relPath}: field "${mf.field}" expected boolean, got "${trimmed}"`);
    }
    case "date":
    case "timestamptz": {
      const t = Date.parse(trimmed);
      if (Number.isNaN(t)) throw new Error(`${relPath}: field "${mf.field}" expected date, got "${trimmed}"`);
      // A `date` column would silently truncate a timestamp; hand it the date part only.
      const iso = new Date(t).toISOString();
      return mf.type === "date" ? iso.slice(0, 10) : iso;
    }
  }
}

export function extractFile(
  relPath: string, raw: string, mtime: Date,
  termFields?: TermField[], metadataFields?: MetadataField[],
): ExtractedFile {
  let content = raw;
  let owner: string | null = null;
  const terms: Record<string, string | string[] | null> = {};
  const metadata: Record<string, string | number | boolean | null> = {};

  // Initialize requested term fields to null
  for (const tf of termFields ?? []) terms[tf.field] = null;
  // Initialize requested metadata fields to null
  for (const mf of metadataFields ?? []) metadata[mf.field] = null;

  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    const m = fm[1]!.match(/^owner:\s*(.+)$/m);
    if (m) owner = m[1]!.trim();
    for (const tf of termFields ?? []) {
      // tf.field is a config-validated vocabulary slug ([a-z][a-z0-9_]*) — safe inside a regex.
      const tm = fm[1]!.match(new RegExp(`^${tf.field}:\\s*(.+)$`, "m"));
      if (tm) terms[tf.field] = parseTermValue(relPath, tf, tm[1]!.trim());
    }
    for (const mf of metadataFields ?? []) {
      // mf.field is a config-validated field name ([a-z_][a-z0-9_]*) — safe inside a regex.
      const mm = fm[1]!.match(new RegExp(`^${mf.field}:\\s*(.+)$`, "m"));
      if (mm) metadata[mf.field] = coerceMetadataValue(relPath, mf, mm[1]!.trim());
    }
    content = raw.slice(fm[0]!.length);
  }
  const h = content.match(/^#\s+(.+)$/m);
  const title = h ? h[1]!.trim() : basename(relPath).replace(/\.(md|txt)$/i, "");
  const checksum = createHash("sha256").update(raw).digest("hex");
  return { path: relPath, title, owner, terms, metadata, updatedAt: mtime, content: content.trim(), checksum };
}
