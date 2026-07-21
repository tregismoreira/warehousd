import { createHash } from "node:crypto";
import { basename } from "node:path";

export type ExtractedDoc = {
  path: string; title: string; owner: string | null;
  updatedAt: Date; content: string; checksum: string;
};

export function extractDoc(relPath: string, raw: string, mtime: Date): ExtractedDoc {
  let content = raw;
  let owner: string | null = null;
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    const m = fm[1]!.match(/^owner:\s*(.+)$/m);
    if (m) owner = m[1]!.trim();
    content = raw.slice(fm[0]!.length);
  }
  const h = content.match(/^#\s+(.+)$/m);
  const title = h ? h[1]!.trim() : basename(relPath).replace(/\.(md|txt)$/i, "");
  const checksum = createHash("sha256").update(raw).digest("hex");
  return { path: relPath, title, owner, updatedAt: mtime, content: content.trim(), checksum };
}
