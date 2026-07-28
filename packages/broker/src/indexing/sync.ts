import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { WarehousdConfig } from "../config/schema";
import { extractFile } from "./extract";
import { chunkText } from "./chunk";
import { loadTaxonomyBindings } from "../taxonomy";

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
  db: Pool, cfg: WarehousdConfig, env: "dev" | "live", collection: string, sourceDir: string,
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

  // Load taxonomy bindings for this collection
  const bindings = await loadTaxonomyBindings(db, cfg, collection, env);
  const termFields = bindings.map(b => b.field);

  for (const rel of walk(sourceDir).sort()) {
    seen.add(rel);
    const abs = join(sourceDir, rel);
    const file = extractFile(rel, readFileSync(abs, "utf8"), statSync(abs).mtime, termFields.length > 0 ? termFields : undefined);

    // Validate extracted terms against known valid terms
    for (const binding of bindings) {
      const term = file.terms[binding.field];
      const terms = Array.isArray(term) ? term : (term ? [term] : []);
      // For now, all bound vocabularies are required (Stage 2 may make some optional)
      if (terms.length === 0 && term === null) {
        throw new Error(`${rel}: missing required ${binding.field} frontmatter`);
      }
      if (terms.length > 0) {
        for (const t of terms) {
          if (!binding.slugs.includes(t))
            throw new Error(`${rel}: unknown ${binding.field} term "${t}" (valid: ${binding.slugs.join(", ")})`);
        }
      }
    }

    const prev = existing.get(rel);
    if (prev && prev.checksum === file.checksum) { skipped++; continue; }
    const id = prev?.id ?? randomUUID();

    // Build term column updates
    const termCols: string[] = [];
    const termVals: unknown[] = [];
    for (const binding of bindings) {
      const term = file.terms[binding.field];
      const terms = Array.isArray(term) ? term : (term ? [term] : []);
      termCols.push(`"${binding.field}"`);
      termVals.push(binding.multiple ? terms : (terms[0] ?? null));
    }

    if (prev) {
      const setClauses = termCols.map((col, i) => `${col}=$${i + 6}`).join(", ");
      const sql = `update ${filesT} set title=$2, owner=$3, checksum=$4, updated_at=$5${termCols.length > 0 ? ", " + setClauses : ""} where id=$1`;
      await db.query(sql, [id, file.title, file.owner, file.checksum, file.updatedAt, ...termVals]);
      await db.query(`delete from ${documentsT} where file_id=$1`, [id]);
    } else {
      const placeholders = termVals.map((_, i) => `$${i + 7}`).join(",");
      const sql = `insert into ${filesT} (id, title, path, owner, checksum, updated_at${termCols.length > 0 ? ", " + termCols.join(", ") : ""})
       values ($1,$2,$3,$4,$5,$6${termCols.length > 0 ? "," + placeholders : ""})`;
      await db.query(sql, [id, file.title, rel, file.owner, file.checksum, file.updatedAt, ...termVals]);
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
