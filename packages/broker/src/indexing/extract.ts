import { createHash } from "node:crypto";
import { basename } from "node:path";

// One entry per vocabulary bound to the collection. `multiple` decides whether the
// frontmatter value parses as a list (string[]) or a scalar (string).
export type TermField = { field: string; multiple?: boolean };

export type ExtractedFile = {
  path: string; title: string; owner: string | null;
  // Exactly one key per requested term field. A requested field absent from the
  // frontmatter is `null` — never `undefined` — so callers can tell "not asked for"
  // (key missing) from "asked for, not present" (null).
  terms: Record<string, string | string[] | null>;
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

export function extractFile(
  relPath: string, raw: string, mtime: Date, termFields?: TermField[],
): ExtractedFile {
  let content = raw;
  let owner: string | null = null;
  const terms: Record<string, string | string[] | null> = {};
  for (const tf of termFields ?? []) terms[tf.field] = null;

  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    const m = fm[1]!.match(/^owner:\s*(.+)$/m);
    if (m) owner = m[1]!.trim();
    for (const tf of termFields ?? []) {
      // tf.field is a config-validated vocabulary slug ([a-z][a-z0-9_]*) — safe inside a regex.
      const tm = fm[1]!.match(new RegExp(`^${tf.field}:\\s*(.+)$`, "m"));
      if (tm) terms[tf.field] = parseTermValue(relPath, tf, tm[1]!.trim());
    }
    content = raw.slice(fm[0]!.length);
  }
  const h = content.match(/^#\s+(.+)$/m);
  const title = h ? h[1]!.trim() : basename(relPath).replace(/\.(md|txt)$/i, "");
  const checksum = createHash("sha256").update(raw).digest("hex");
  return { path: relPath, title, owner, terms, updatedAt: mtime, content: content.trim(), checksum };
}
