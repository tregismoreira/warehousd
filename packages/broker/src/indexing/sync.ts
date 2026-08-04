import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { Pool } from "pg";
import { extractFile, type MetadataField } from "./extract";
import { chunkText } from "./chunk";
import { embedChunks } from "../embedding/sync";
import type { TaxonomyBinding } from "../taxonomy";
import type { BinaryExtractor, Embedder } from "../providers";

const TEXT_EXT = /\.(md|txt)$/i;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function walk(root: string, binaryExt: readonly string[], dir = root): string[] {
  const out: string[] = [];
  // A sidecar is metadata for the file beside it, never a document of its own.
  const isSidecar = (n: string) =>
    /\.(ya?ml)$/i.test(n) && binaryExt.some((x) => n.includes(`.${x}.`));
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(root, binaryExt, p));
    else if (isSidecar(e.name)) continue;
    else if (TEXT_EXT.test(e.name)) out.push(relative(root, p));
    else if (binaryExt.includes(extname(e.name).slice(1).toLowerCase()))
      out.push(relative(root, p));
  }
  return out;
}

// A binary carries no frontmatter, so its owner, terms and metadata come from a sidecar YAML
// beside it: `contract.pdf` is described by `contract.pdf.yml`. Without this a bound vocabulary
// would have nowhere to come from, and indexing would either fail or — much worse — silently
// produce an unscoped document reachable by a grant approved on the assumption it carried a term.
function readSidecar(absPath: string): Record<string, unknown> {
  for (const ext of [".yml", ".yaml"]) {
    const p = `${absPath}${ext}`;
    if (!existsSync(p)) continue;
    const parsed: unknown = parseYaml(readFileSync(p, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  }
  return {};
}

// Bindings are resolved by the caller via `loadTaxonomyBindings(db, cfg, collection, env)`,
// because a dataset-sourced vocabulary's term set lives in env-scoped `app.terms`, not in
// the YAML. Omitting them indexes the collection as unbound.
export async function indexCollection(
  db: Pool,
  env: "dev" | "live",
  collection: string,
  sourceDir: string,
  opts: {
    taxonomies?: TaxonomyBinding[];
    metadata?: MetadataField[];
    // Injected by the caller (CLI or web), never constructed here — the PDF and DOCX parsers
    // live in @warehousd/providers. Absent means only .md/.txt are picked up, which is exactly
    // what this function did before binaries were supported.
    extractor?: BinaryExtractor | undefined;
    // Absent means chunks are stored with a null embedding, and `warehousd embed` can fill them
    // in later. Present means they are embedded in the same pass.
    embedder?: Embedder | undefined;
  } = {},
): Promise<{ indexed: number; skipped: number; deleted: number }> {
  const schema = env === "dev" ? "data_synth" : "data_live";
  // collection is caller-controlled (server-side config/CLI, not raw user input),
  // so this identifier interpolation is safe (SQL identifiers can't be parameterized).
  const filesT = `${schema}."${collection}__files"`;
  const documentsT = `${schema}."${collection}__documents"`;
  const existing = new Map<string, { id: string; checksum: string }>(
    (
      await db.query<{ id: string; path: string; checksum: string }>(
        `select id, path, checksum from ${filesT}`,
      )
    ).rows.map((r) => [r.path, { id: r.id, checksum: r.checksum }]),
  );
  let indexed = 0,
    skipped = 0,
    deleted = 0;
  const seen = new Set<string>();

  const bindings = opts.taxonomies ?? [];
  const termFields = bindings.map((b) => ({ field: b.field, multiple: b.multiple }));
  const metadataFields = opts.metadata ?? [];

  const binaryExt = opts.extractor?.extensions ?? [];

  for (const rel of walk(sourceDir, binaryExt).sort()) {
    seen.add(rel);
    const abs = join(sourceDir, rel);
    const isBinary = !TEXT_EXT.test(rel);
    let file;
    let blob: Buffer | null = null;
    let contentType: string | null = null;
    if (isBinary) {
      blob = readFileSync(abs);
      const ext = extname(rel).slice(1).toLowerCase();
      contentType = ext === "pdf" ? "application/pdf" : DOCX_MIME;
      const out = await opts.extractor!.extract(rel, blob);
      // The sidecar plays exactly the role frontmatter plays for markdown: same keys, same
      // required-term rule below, so a binary and a .md are indistinguishable downstream.
      const side = readSidecar(abs);
      file = {
        path: rel,
        title: out.title ?? basename(rel, extname(rel)),
        owner: typeof side.owner === "string" ? side.owner : null,
        terms: Object.fromEntries(
          termFields.map((t) => [t.field, (side[t.field] ?? null) as string | string[] | null]),
        ),
        metadata: Object.fromEntries(metadataFields.map((m) => [m.field, side[m.field] ?? null])),
        updatedAt: statSync(abs).mtime,
        content: out.text,
        // Over the extracted TEXT, not the bytes: two exports of the same document differ byte
        // for byte (timestamps, producer strings) while carrying identical content, and
        // re-chunking and re-embedding on every index would be pure waste.
        checksum: createHash("sha256").update(out.text).digest("hex"),
      };
    } else {
      file = extractFile(
        rel,
        readFileSync(abs, "utf8"),
        statSync(abs).mtime,
        termFields.length ? termFields : undefined,
        metadataFields.length ? metadataFields : undefined,
      );
    }

    // Every bound vocabulary is required frontmatter, and every term must be known.
    // Failing loudly here is deliberate: a silently unscoped document would be reachable
    // by a grant that was approved on the assumption it carried a term.
    const termValues: unknown[] = [];
    for (const b of bindings) {
      const raw = file.terms[b.field] ?? null;
      const values = raw === null ? [] : Array.isArray(raw) ? raw : [raw];
      if (values.length === 0)
        throw new Error(
          `${rel}: missing required ${b.field} frontmatter (valid: ${b.slugs.join(", ")})`,
        );
      for (const t of values)
        if (!b.slugs.includes(t))
          throw new Error(`${rel}: unknown ${b.field} term "${t}" (valid: ${b.slugs.join(", ")})`);
      termValues.push(b.multiple ? values : values[0]!);
    }

    const prev = existing.get(rel);
    if (prev && prev.checksum === file.checksum) {
      skipped++;
      continue;
    }
    const id = prev?.id ?? randomUUID();
    const termCols = bindings.map((b) => `"${b.field}"`);
    const metadataCols = metadataFields.map((m) => `"${m.field}"`);
    const metadataValues = metadataFields.map((m) => file.metadata[m.field] ?? null);

    if (prev) {
      let sets = termCols.map((col, i) => `, ${col}=$${i + 6}`).join("");
      sets += metadataCols.map((col, i) => `, ${col}=$${i + 6 + termCols.length}`).join("");
      await db.query(
        `update ${filesT} set title=$2, owner=$3, checksum=$4, updated_at=$5,
           blob=$${6 + termCols.length + metadataCols.length},
           content_type=$${7 + termCols.length + metadataCols.length},
           byte_size=$${8 + termCols.length + metadataCols.length}${sets} where id=$1`,
        [
          id,
          file.title,
          file.owner,
          file.checksum,
          file.updatedAt,
          ...termValues,
          ...metadataValues,
          blob,
          contentType,
          blob?.byteLength ?? null,
        ],
      );
      await db.query(`delete from ${documentsT} where file_id=$1`, [id]);
    } else {
      const allCols = [...termCols, ...metadataCols];
      const cols = allCols.length ? `, ${allCols.join(", ")}` : "";
      const ph = [...termValues, ...metadataValues].map((_, i) => `,$${i + 7}`).join("");
      const n = 7 + termValues.length + metadataValues.length;
      await db.query(
        `insert into ${filesT} (id, title, path, owner, checksum, updated_at${cols}, blob, content_type, byte_size)
         values ($1,$2,$3,$4,$5,$6${ph},$${n},$${n + 1},$${n + 2})`,
        [
          id,
          file.title,
          rel,
          file.owner,
          file.checksum,
          file.updatedAt,
          ...termValues,
          ...metadataValues,
          blob,
          contentType,
          blob?.byteLength ?? null,
        ],
      );
    }

    const pieces = chunkText(file.content);
    const chunkIds = pieces.map(() => randomUUID());
    for (let i = 0; i < pieces.length; i++)
      await db.query(
        `insert into ${documentsT} (id, file_id, document_seq, content) values ($1,$2,$3,$4)`,
        [chunkIds[i], id, i, pieces[i]],
      );
    // Embedded in the same pass when an embedder was supplied. Chunks are deleted and reinserted
    // whenever the checksum changes, so an embedding can never outlive the text it describes —
    // the "search still returns the pre-edit version" failure cannot happen here.
    if (opts.embedder && pieces.length) {
      const client = await db.connect();
      try {
        await embedChunks(client, documentsT, chunkIds, pieces, opts.embedder);
      } finally {
        client.release();
      }
    }
    indexed++;
  }
  for (const [path, row] of existing)
    if (!seen.has(path)) {
      await db.query(`delete from ${filesT} where id=$1`, [row.id]);
      deleted++;
    }
  return { indexed, skipped, deleted };
}
