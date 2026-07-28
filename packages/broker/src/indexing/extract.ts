import { createHash } from "node:crypto";
import { basename } from "node:path";

export type ExtractedFile = {
  path: string; title: string; owner: string | null; terms: Record<string, string | string[] | null>;
  updatedAt: Date; content: string; checksum: string;
};

export function extractFile(relPath: string, raw: string, mtime: Date, termFields?: string[]): ExtractedFile {
  let content = raw;
  let owner: string | null = null;
  const terms: Record<string, string | string[] | null> = {};
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    const m = fm[1]!.match(/^owner:\s*(.+)$/m);
    if (m) owner = m[1]!.trim();
    if (termFields) {
      for (const termField of termFields) {
        // termField is a config-validated vocabulary slug ([a-z][a-z0-9_]*) — safe inside a regex.
        const tm = fm[1]!.match(new RegExp(`^${termField}:\\s*(.+)$`, "m"));
        if (tm) {
          const val = tm[1]!.trim();
          // Try to parse as YAML array [a, b] or semicolon-separated list a;b or single value
          if (val.startsWith('[') && val.endsWith(']')) {
            // YAML array format [a, b, c]
            const items = val.slice(1, -1).split(',').map(s => s.trim());
            terms[termField] = items;
          } else if (val.includes(';')) {
            // Semicolon-separated format a;b;c
            terms[termField] = val.split(';').map(s => s.trim());
          } else {
            // Single value
            terms[termField] = val;
          }
        } else {
          terms[termField] = null;
        }
      }
    }
    content = raw.slice(fm[0]!.length);
  }
  const h = content.match(/^#\s+(.+)$/m);
  const title = h ? h[1]!.trim() : basename(relPath).replace(/\.(md|txt)$/i, "");
  const checksum = createHash("sha256").update(raw).digest("hex");
  return { path: relPath, title, owner, terms, updatedAt: mtime, content: content.trim(), checksum };
}
