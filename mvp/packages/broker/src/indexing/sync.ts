import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { extractDoc } from "./extract";
import { chunkText } from "./chunk";

function walk(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(root, p));
    else if (/\.(md|txt)$/i.test(e.name)) out.push(relative(root, p));
  }
  return out;
}

export async function indexCollection(
  db: Pool, env: "dev" | "live", collection: string, sourceDir: string,
): Promise<{ indexed: number; skipped: number; deleted: number }> {
  const schema = env === "dev" ? "data_synth" : "data_live";
  // collection is caller-controlled (server-side config/CLI, not raw user input),
  // so this identifier interpolation is safe (SQL identifiers can't be parameterized).
  const docsT = `${schema}."${collection}__docs"`;
  const chunksT = `${schema}."${collection}__chunks"`;
  const existing = new Map<string, { id: string; checksum: string }>(
    (await db.query(`select id, path, checksum from ${docsT}`)).rows
      .map((r: any) => [r.path, { id: r.id, checksum: r.checksum }]));
  let indexed = 0, skipped = 0, deleted = 0;
  const seen = new Set<string>();
  for (const rel of walk(sourceDir).sort()) {
    seen.add(rel);
    const abs = join(sourceDir, rel);
    const doc = extractDoc(rel, readFileSync(abs, "utf8"), statSync(abs).mtime);
    const prev = existing.get(rel);
    if (prev && prev.checksum === doc.checksum) { skipped++; continue; }
    const id = prev?.id ?? randomUUID();
    if (prev) {
      await db.query(`update ${docsT} set title=$2, owner=$3, checksum=$4, updated_at=$5 where id=$1`,
        [id, doc.title, doc.owner, doc.checksum, doc.updatedAt]);
      await db.query(`delete from ${chunksT} where document_id=$1`, [id]);
    } else {
      await db.query(`insert into ${docsT} (id, title, path, owner, checksum, updated_at)
        values ($1,$2,$3,$4,$5,$6)`, [id, doc.title, rel, doc.owner, doc.checksum, doc.updatedAt]);
    }
    const pieces = chunkText(doc.content);
    for (let i = 0; i < pieces.length; i++)
      await db.query(`insert into ${chunksT} (id, document_id, chunk_index, content) values ($1,$2,$3,$4)`,
        [randomUUID(), id, i, pieces[i]]);
    indexed++;
  }
  for (const [path, row] of existing)
    if (!seen.has(path)) { await db.query(`delete from ${docsT} where id=$1`, [row.id]); deleted++; }
  return { indexed, skipped, deleted };
}
