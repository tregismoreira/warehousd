import { createHash } from "node:crypto";
import { basename } from "node:path";

export type ExtractedFile = {
  path: string; title: string; owner: string | null; term: string | null;
  updatedAt: Date; content: string; checksum: string;
};

export function extractFile(relPath: string, raw: string, mtime: Date, termField?: string): ExtractedFile {
  let content = raw;
  let owner: string | null = null;
  let term: string | null = null;
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    const m = fm[1]!.match(/^owner:\s*(.+)$/m);
    if (m) owner = m[1]!.trim();
    if (termField) {
      // termField is a config-validated vocabulary slug ([a-z][a-z0-9_]*) — safe inside a regex.
      const tm = fm[1]!.match(new RegExp(`^${termField}:\\s*(.+)$`, "m"));
      if (tm) term = tm[1]!.trim();
    }
    content = raw.slice(fm[0]!.length);
  }
  const h = content.match(/^#\s+(.+)$/m);
  const title = h ? h[1]!.trim() : basename(relPath).replace(/\.(md|txt)$/i, "");
  const checksum = createHash("sha256").update(raw).digest("hex");
  return { path: relPath, title, owner, term, updatedAt: mtime, content: content.trim(), checksum };
}
