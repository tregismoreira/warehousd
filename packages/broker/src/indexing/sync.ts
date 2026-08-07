import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Pool } from "pg";
import type { MetadataField } from "./extract";
import { ingestFile, filesTable, TEXT_EXT, type IngestDeps } from "./ingest";
import type { TaxonomyBinding } from "../taxonomy";
import type { BinaryExtractor, Embedder } from "../providers";

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

// How far through the two passes an index run is. `phase` because they measure different things
// and a bar that reset from 200/200 to 3 would look like a fault.
export type IndexProgress = {
  done: number;
  total?: number | undefined;
  phase: "index" | "prune";
};

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
    // Same shape as EmbedProgress, so there is one convention rather than five. The total is
    // known here — the directory walk happens up front — but the deletion sweep afterwards is
    // counted separately, because a file leaving the source directory is not indexing work.
    onProgress?: ((p: IndexProgress) => void) | undefined;
  } = {},
): Promise<{ indexed: number; skipped: number; deleted: number }> {
  const schema = env === "dev" ? "data_synth" : "data_live";
  const filesT = filesTable(schema, collection);
  // Only the rows this indexer put there. An uploaded document has `origin = 'upload'` and is
  // deliberately absent from the sweep below — see the note on it.
  const existing = new Map<string, string>(
    (
      await db.query<{ id: string; path: string }>(
        `select id, path from ${filesT} where origin = 'index'`,
      )
    ).rows.map((r) => [r.path, r.id]),
  );
  let indexed = 0,
    skipped = 0,
    deleted = 0;
  const seen = new Set<string>();

  const deps: IngestDeps = {
    ...(opts.taxonomies ? { taxonomies: opts.taxonomies } : {}),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
    extractor: opts.extractor,
    embedder: opts.embedder,
  };

  // Materialised before the loop rather than iterated lazily, so `total` is a real number from
  // the first callback instead of climbing as the walk proceeds.
  const files = walk(sourceDir, opts.extractor?.extensions ?? []).sort();
  opts.onProgress?.({ done: 0, total: files.length, phase: "index" });

  for (const rel of files) {
    seen.add(rel);
    const abs = join(sourceDir, rel);
    const r = await ingestFile(
      db,
      schema,
      collection,
      {
        path: rel,
        bytes: readFileSync(abs),
        sidecar: readSidecar(abs),
        updatedAt: statSync(abs).mtime,
        origin: "index",
      },
      deps,
    );
    if (r.status === "skipped") skipped++;
    else indexed++;
    opts.onProgress?.({ done: indexed + skipped, total: files.length, phase: "index" });
  }
  // Directory indexing is a mirror: a file that left the source directory leaves the collection.
  // Scoped to `origin = 'index'` above, because an uploaded document was never in that directory
  // and must not be deleted by the first `warehousd index` that runs after it lands.
  for (const [path, id] of existing)
    if (!seen.has(path)) {
      await db.query(`delete from ${filesT} where id=$1`, [id]);
      deleted++;
      opts.onProgress?.({ done: deleted, phase: "prune" });
    }
  return { indexed, skipped, deleted };
}
