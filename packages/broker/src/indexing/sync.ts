import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { extractFile } from "./extract";
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

export type IndexTaxonomy = { field: string; slugs: string[] };

export async function indexCollection(
  db: Pool, env: "dev" | "live", collection: string, sourceDir: string,
  opts: { taxonomy?: IndexTaxonomy } = {},
): Promise<{ indexed: number; skipped: number; deleted: number }> {
  const schema = env === "dev" ? "data_synth" : "data_live";
  // collection is caller-controlled (server-side config/CLI, not raw user input),
  // so this identifier interpolation is safe (SQL identifiers can't be parameterized).
  const filesT = `${schema}."${collection}__files"`;
  const documentsT = `${schema}."${collection}__documents"`;
  const existing = new Map<string, { id: string; checksum: string }>(
    (await db.query(`select id, path, checksum from ${filesT}`)).rows
      .map((r: any) => [r.path, { id: r.id, checksum: r.checksum }]));
  let indexed = 0, skipped = 0, deleted = 0;
  const seen = new Set<string>();
  const tax = opts.taxonomy;
  for (const rel of walk(sourceDir).sort()) {
    seen.add(rel);
    const abs = join(sourceDir, rel);
    const file = extractFile(rel, readFileSync(abs, "utf8"), statSync(abs).mtime, tax?.field);
    if (tax && (!file.term || !tax.slugs.includes(file.term)))
      throw new Error(`${rel}: ${file.term
        ? `unknown ${tax.field} term "${file.term}"`
        : `missing required ${tax.field} frontmatter`} (valid: ${tax.slugs.join(", ")})`);
    const prev = existing.get(rel);
    if (prev && prev.checksum === file.checksum) { skipped++; continue; }
    const id = prev?.id ?? randomUUID();
    if (prev) {
      await db.query(
        `update ${filesT} set title=$2, owner=$3, checksum=$4, updated_at=$5${tax ? `, "${tax.field}"=$6` : ""} where id=$1`,
        [id, file.title, file.owner, file.checksum, file.updatedAt, ...(tax ? [file.term] : [])]);
      await db.query(`delete from ${documentsT} where file_id=$1`, [id]);
    } else {
      await db.query(
        `insert into ${filesT} (id, title, path, owner, checksum, updated_at${tax ? `, "${tax.field}"` : ""})
         values ($1,$2,$3,$4,$5,$6${tax ? ",$7" : ""})`,
        [id, file.title, rel, file.owner, file.checksum, file.updatedAt, ...(tax ? [file.term] : [])]);
    }
    const pieces = chunkText(file.content);
    for (let i = 0; i < pieces.length; i++)
      await db.query(`insert into ${documentsT} (id, file_id, document_seq, content) values ($1,$2,$3,$4)`,
        [randomUUID(), id, i, pieces[i]]);
    indexed++;
  }
  for (const [path, row] of existing)
    if (!seen.has(path)) { await db.query(`delete from ${filesT} where id=$1`, [row.id]); deleted++; }
  return { indexed, skipped, deleted };
}
