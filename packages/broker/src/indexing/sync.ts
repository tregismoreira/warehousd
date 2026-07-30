import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { extractFile, type MetadataField } from "./extract";
import { chunkText } from "./chunk";
import type { TaxonomyBinding } from "../taxonomy";

function walk(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(root, p));
    else if (/\.(md|txt)$/i.test(e.name)) out.push(relative(root, p));
  }
  return out;
}

// Bindings are resolved by the caller via `loadTaxonomyBindings(db, cfg, collection, env)`,
// because a dataset-sourced vocabulary's term set lives in env-scoped `app.terms`, not in
// the YAML. Omitting them indexes the collection as unbound.
export async function indexCollection(
  db: Pool, env: "dev" | "live", collection: string, sourceDir: string,
  opts: { taxonomies?: TaxonomyBinding[], metadata?: MetadataField[] } = {},
): Promise<{ indexed: number; skipped: number; deleted: number }> {
  const schema = env === "dev" ? "data_synth" : "data_live";
  // collection is caller-controlled (server-side config/CLI, not raw user input),
  // so this identifier interpolation is safe (SQL identifiers can't be parameterized).
  const filesT = `${schema}."${collection}__files"`;
  const documentsT = `${schema}."${collection}__documents"`;
  const existing = new Map<string, { id: string; checksum: string }>(
    (await db.query<{ id: string; path: string; checksum: string }>(
      `select id, path, checksum from ${filesT}`)).rows
      .map((r) => [r.path, { id: r.id, checksum: r.checksum }]));
  let indexed = 0, skipped = 0, deleted = 0;
  const seen = new Set<string>();

  const bindings = opts.taxonomies ?? [];
  const termFields = bindings.map((b) => ({ field: b.field, multiple: b.multiple }));
  const metadataFields = opts.metadata ?? [];

  for (const rel of walk(sourceDir).sort()) {
    seen.add(rel);
    const abs = join(sourceDir, rel);
    const file = extractFile(rel, readFileSync(abs, "utf8"), statSync(abs).mtime,
      termFields.length ? termFields : undefined,
      metadataFields.length ? metadataFields : undefined);

    // Every bound vocabulary is required frontmatter, and every term must be known.
    // Failing loudly here is deliberate: a silently unscoped document would be reachable
    // by a grant that was approved on the assumption it carried a term.
    const termValues: unknown[] = [];
    for (const b of bindings) {
      const raw = file.terms[b.field] ?? null;
      const values = raw === null ? [] : Array.isArray(raw) ? raw : [raw];
      if (values.length === 0)
        throw new Error(`${rel}: missing required ${b.field} frontmatter (valid: ${b.slugs.join(", ")})`);
      for (const t of values)
        if (!b.slugs.includes(t))
          throw new Error(`${rel}: unknown ${b.field} term "${t}" (valid: ${b.slugs.join(", ")})`);
      termValues.push(b.multiple ? values : values[0]!);
    }

    const prev = existing.get(rel);
    if (prev && prev.checksum === file.checksum) { skipped++; continue; }
    const id = prev?.id ?? randomUUID();
    const termCols = bindings.map((b) => `"${b.field}"`);
    const metadataCols = metadataFields.map((m) => `"${m.field}"`);
    const metadataValues = metadataFields.map((m) => file.metadata[m.field] ?? null);

    if (prev) {
      let sets = termCols.map((col, i) => `, ${col}=$${i + 6}`).join("");
      sets += metadataCols.map((col, i) => `, ${col}=$${i + 6 + termCols.length}`).join("");
      await db.query(
        `update ${filesT} set title=$2, owner=$3, checksum=$4, updated_at=$5${sets} where id=$1`,
        [id, file.title, file.owner, file.checksum, file.updatedAt, ...termValues, ...metadataValues]);
      await db.query(`delete from ${documentsT} where file_id=$1`, [id]);
    } else {
      const allCols = [...termCols, ...metadataCols];
      const cols = allCols.length ? `, ${allCols.join(", ")}` : "";
      const ph = [...termValues, ...metadataValues].map((_, i) => `,$${i + 7}`).join("");
      await db.query(
        `insert into ${filesT} (id, title, path, owner, checksum, updated_at${cols})
         values ($1,$2,$3,$4,$5,$6${ph})`,
        [id, file.title, rel, file.owner, file.checksum, file.updatedAt, ...termValues, ...metadataValues]);
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
