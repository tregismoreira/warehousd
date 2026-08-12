import { createHash, randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import type { Pool, PoolClient } from "pg";
import { extractFile, type MetadataField } from "./extract";
import { chunkText } from "./chunk";
import { embedChunks } from "../embedding/sync";
import type { TaxonomyBinding } from "../taxonomy";
import type { BinaryExtractor, Embedder } from "../providers";
import { ident } from "../sql/ident";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const TEXT_EXT = /\.(md|txt)$/i;

// Derived from the name, not from what the client claimed: an upload's own Content-Type is
// caller-controlled, and dispatching extraction on it would let a caller hand a PDF to the
// markdown path (or the reverse). The extension is what the directory indexer uses too.
export function contentTypeFor(path: string): string | null {
  const ext = extname(path).slice(1).toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (ext === "docx") return DOCX_MIME;
  return null;
}

export const FILE_ORIGINS = ["index", "upload"] as const;
export type FileOrigin = (typeof FILE_ORIGINS)[number];

/**
 * This file cannot be indexed, and the person holding it is the one who can fix that.
 *
 * A corrupt PDF, a missing term for a bound vocabulary, a metadata value that will not coerce.
 * Typed rather than recognised by its message so the upload surface can turn it into a refusal
 * without pattern-matching on prose — and so a driver error, which must never be echoed to
 * anyone, cannot be mistaken for one.
 */
export class DocumentRejected extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "DocumentRejected";
  }
}

/**
 * One file, on its way into a collection.
 *
 * `sidecar` plays the part frontmatter plays for markdown — owner, terms and metadata for a
 * format that cannot carry them inline. The directory indexer reads it from `<file>.pdf.yml`;
 * an upload carries it in the form. It is ignored for text, which has frontmatter of its own.
 */
export type IngestInput = {
  /** Relative path. This is a file's identity within a collection, and what re-upload matches on. */
  path: string;
  bytes: Buffer;
  sidecar?: Record<string, unknown>;
  updatedAt: Date;
  /**
   * How the file arrived. `index` rows are a mirror of a source directory and are swept when
   * they leave it; `upload` rows exist only here, so nothing sweeps them. Without the
   * distinction the first `warehousd index` after an upload would silently delete it.
   */
  origin: FileOrigin;
};

export type IngestDeps = {
  taxonomies?: TaxonomyBinding[];
  metadata?: MetadataField[];
  extractor?: BinaryExtractor | undefined;
  embedder?: Embedder | undefined;
};

export type IngestResult = {
  fileId: string;
  /** `skipped` means the extracted text was byte-identical to what is already stored. */
  status: "indexed" | "skipped";
  checksum: string;
  title: string;
};

export function filesTable(schema: string, collection: string): string {
  // collection is caller-controlled (server-side config/CLI, not raw user input) — ident() is
  // the check applied at the point of interpolation anyway, per its own header comment, rather
  // than trusted to hold upstream.
  return `${schema}.${ident(`${collection}__files`)}`;
}

export function documentsTable(schema: string, collection: string): string {
  return `${schema}.${ident(`${collection}__documents`)}`;
}

/**
 * Extract, validate, store, chunk and embed a single file.
 *
 * Pulled out of `indexCollection` rather than written twice: the upload surface and the
 * directory indexer have to produce indistinguishable rows, or a document's reachability would
 * depend on how it arrived. Chunking, checksum semantics and — most of all — the required-term
 * rule are enforced here once, for both.
 */
export async function ingestFile(
  db: Pool,
  schema: string,
  collection: string,
  workspaceId: string,
  input: IngestInput,
  deps: IngestDeps = {},
): Promise<IngestResult> {
  const filesT = filesTable(schema, collection);
  const documentsT = documentsTable(schema, collection);
  const bindings = deps.taxonomies ?? [];
  const metadataFields = deps.metadata ?? [];
  const termFields = bindings.map((b) => ({ field: b.field, multiple: b.multiple }));

  const rel = input.path;
  const contentType = contentTypeFor(rel);
  let file;
  if (contentType) {
    if (!deps.extractor)
      throw new DocumentRejected(rel, `${rel}: no extractor is configured for this file type`);
    // A corrupt or scanned document is the file's problem, not the system's. The extractor's
    // own error already names the file and carries no library detail (see `ExtractionFailed`).
    let out;
    try {
      out = await deps.extractor.extract(rel, input.bytes);
    } catch (err) {
      throw new DocumentRejected(rel, err instanceof Error ? err.message : String(err));
    }
    const side = input.sidecar ?? {};
    file = {
      path: rel,
      title: out.title ?? basename(rel, extname(rel)),
      owner: typeof side.owner === "string" ? side.owner : null,
      terms: Object.fromEntries(
        termFields.map((t) => [t.field, (side[t.field] ?? null) as string | string[] | null]),
      ),
      metadata: Object.fromEntries(metadataFields.map((m) => [m.field, side[m.field] ?? null])),
      updatedAt: input.updatedAt,
      content: out.text,
      // Over the extracted TEXT, not the bytes: two exports of the same document differ byte
      // for byte (timestamps, producer strings) while carrying identical content, and
      // re-chunking and re-embedding on every index would be pure waste.
      checksum: createHash("sha256").update(out.text).digest("hex"),
    };
  } else {
    try {
      file = extractFile(
        rel,
        input.bytes.toString("utf8"),
        input.updatedAt,
        termFields.length ? termFields : undefined,
        metadataFields.length ? metadataFields : undefined,
      );
    } catch (err) {
      // A frontmatter value that will not coerce to its declared type. Same class of problem as
      // a missing term: the file is wrong, and its author is who can fix it.
      throw new DocumentRejected(rel, err instanceof Error ? err.message : String(err));
    }
    // The sidecar fills in what the frontmatter did not say, and never overrides it. A text file
    // that carries its own owner and terms keeps them wherever it came from; one that does not
    // can still be uploaded into a collection with a bound vocabulary, by supplying them in the
    // form. Without this, the only way to upload a plain .md would be to edit it first.
    const side = input.sidecar ?? {};
    if (file.owner === null && typeof side.owner === "string") file.owner = side.owner;
    for (const t of termFields)
      if (file.terms[t.field] == null && side[t.field] !== undefined)
        file.terms[t.field] = side[t.field] as string | string[];
    for (const m of metadataFields)
      if (file.metadata[m.field] == null && side[m.field] !== undefined)
        file.metadata[m.field] = side[m.field] as string | number | boolean;
  }

  // Every bound vocabulary is required frontmatter, and every term must be known.
  // Failing loudly here is deliberate: a silently unscoped document would be reachable
  // by a grant that was approved on the assumption it carried a term.
  const termValues: unknown[] = [];
  for (const b of bindings) {
    const raw = file.terms[b.field] ?? null;
    const values = raw === null ? [] : Array.isArray(raw) ? raw : [raw];
    if (values.length === 0)
      throw new DocumentRejected(
        rel,
        `${rel}: missing required ${b.field} frontmatter (valid: ${b.slugs.join(", ")})`,
      );
    for (const t of values)
      if (!b.slugs.includes(t))
        throw new DocumentRejected(
          rel,
          `${rel}: unknown ${b.field} term "${t}" (valid: ${b.slugs.join(", ")})`,
        );
    termValues.push(b.multiple ? values : values[0]!);
  }

  // Scoped by workspace_id, not just path: two workspaces indexing the same collection can each
  // hold a file at the same path, and without this filter the second workspace's ingest would
  // find the first's row, treat it as its own "prev", and overwrite someone else's document.
  const prev = (
    await db.query<{ id: string; checksum: string }>(
      `select id, checksum from ${filesT} where path = $1 and workspace_id = $2`,
      [rel, workspaceId],
    )
  ).rows[0];
  if (prev && prev.checksum === file.checksum)
    return { fileId: prev.id, status: "skipped", checksum: file.checksum, title: file.title };

  const id = prev?.id ?? randomUUID();
  const termCols = bindings.map((b) => `"${b.field}"`);
  const metadataCols = metadataFields.map((m) => `"${m.field}"`);
  const metadataValues = metadataFields.map((m) => file.metadata[m.field] ?? null);
  const blob = input.bytes;

  if (prev) {
    let sets = termCols.map((col, i) => `, ${col}=$${i + 6}`).join("");
    sets += metadataCols.map((col, i) => `, ${col}=$${i + 6 + termCols.length}`).join("");
    await db.query(
      `update ${filesT} set title=$2, owner=$3, checksum=$4, updated_at=$5,
         blob=$${6 + termCols.length + metadataCols.length},
         content_type=$${7 + termCols.length + metadataCols.length},
         byte_size=$${8 + termCols.length + metadataCols.length},
         origin=$${9 + termCols.length + metadataCols.length}${sets} where id=$1`,
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
        blob.byteLength,
        input.origin,
      ],
    );
    await db.query(`delete from ${documentsT} where file_id=$1`, [id]);
  } else {
    const allCols = [...termCols, ...metadataCols];
    const cols = allCols.length ? `, ${allCols.join(", ")}` : "";
    const ph = [...termValues, ...metadataValues].map((_, i) => `,$${i + 7}`).join("");
    const n = 7 + termValues.length + metadataValues.length;
    await db.query(
      `insert into ${filesT} (id, title, path, owner, checksum, updated_at${cols}, blob, content_type, byte_size, origin, workspace_id)
       values ($1,$2,$3,$4,$5,$6${ph},$${n},$${n + 1},$${n + 2},$${n + 3},$${n + 4})`,
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
        blob.byteLength,
        input.origin,
        workspaceId,
      ],
    );
  }

  const pieces = chunkText(file.content);
  const chunkIds = pieces.map(() => randomUUID());
  for (let i = 0; i < pieces.length; i++)
    await db.query(
      `insert into ${documentsT} (id, file_id, document_seq, content, workspace_id) values ($1,$2,$3,$4,$5)`,
      [chunkIds[i], id, i, pieces[i], workspaceId],
    );
  // Embedded in the same pass when an embedder was supplied. Chunks are deleted and reinserted
  // whenever the checksum changes, so an embedding can never outlive the text it describes —
  // the "search still returns the pre-edit version" failure cannot happen here.
  if (deps.embedder && pieces.length) {
    const client: PoolClient = await db.connect();
    try {
      await embedChunks(client, documentsT, chunkIds, pieces, deps.embedder);
    } finally {
      client.release();
    }
  }
  return { fileId: id, status: "indexed", checksum: file.checksum, title: file.title };
}
