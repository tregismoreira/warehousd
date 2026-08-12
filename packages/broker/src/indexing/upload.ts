import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  ingestFile,
  filesTable,
  contentTypeFor,
  DocumentRejected,
  type IngestDeps,
} from "./ingest";

/**
 * Uploading a corpus, one file per request, resumably.
 *
 * The design decision worth stating: **resume is at file granularity, not byte granularity**.
 * A governed document corpus is thousands of small files, not one enormous stream, so the
 * failure worth surviving is "the browser was closed with 800 of 3,000 done" — not "a 4 GB
 * transfer died at 70%". `planUpload` answers, from the database rather than from anything the
 * client remembers, which files are already there byte for byte; the client then uploads only
 * the rest. Re-running it after any interruption is the whole resume mechanism, and it is
 * correct across browsers, machines and sessions because no client-side state is trusted.
 *
 * `blob_checksum` is a generated column, so this costs one index lookup per file and never
 * reads a blob back out.
 */

// A file's own bytes, hashed the way the client is asked to hash them. Exported because the
// upload route verifies the client's claim rather than believing it: a wrong checksum would
// otherwise poison the plan for every later session, which is precisely the "we lost files"
// failure this is meant to prevent.
export function blobChecksum(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const UPLOAD_STATUSES = ["new", "changed", "unchanged"] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export type PlanEntry = { path: string; checksum: string };
export type PlanResult = { path: string; status: UploadStatus };

export type UploadRefusal =
  | "unknown_collection"
  | "not_a_file_collection"
  | "unsupported_type"
  | "checksum_mismatch"
  | "too_large"
  | "empty"
  | "rejected";

export type UploadOutcome =
  | { ok: true; fileId: string; path: string; status: "indexed" | "skipped"; title: string }
  | { ok: false; reason: UploadRefusal; detail?: string };

const schemaFor = (env: "dev" | "live") => (env === "dev" ? "data_synth" : "data_live");

/**
 * Which of these files does the collection already hold, byte for byte?
 *
 * `unchanged` means skip it. `changed` means the path is known but the bytes differ — an
 * upload of it is a revision, and the caller should be told so rather than surprised by it.
 */
export async function planUpload(
  db: Pool,
  env: "dev" | "live",
  collection: string,
  workspaceId: string,
  entries: PlanEntry[],
): Promise<PlanResult[]> {
  if (entries.length === 0) return [];
  const filesT = filesTable(schemaFor(env), collection);
  // Scoped by workspace_id: unscoped, this told a caller in workspace B that a path was
  // "unchanged" because workspace A happened to have already uploaded it — leaking A's file
  // existence and checksum into B's plan.
  const known = new Map<string, string | null>(
    (
      await db.query<{ path: string; blob_checksum: string | null }>(
        `select path, blob_checksum from ${filesT} where path = any($1) and workspace_id = $2`,
        [entries.map((e) => e.path), workspaceId],
      )
    ).rows.map((r) => [r.path, r.blob_checksum]),
  );
  return entries.map((e) => {
    if (!known.has(e.path)) return { path: e.path, status: "new" };
    return {
      path: e.path,
      status: known.get(e.path) === e.checksum ? "unchanged" : "changed",
    };
  });
}

export type UploadInput = {
  path: string;
  bytes: Buffer;
  /** The client's sha256 of `bytes`, hex. Verified, not trusted. */
  checksum?: string | undefined;
  /** Owner, terms and typed metadata — the form's stand-in for a sidecar YAML. */
  sidecar?: Record<string, unknown>;
  updatedAt?: Date | undefined;
  maxBytes: number;
};

/**
 * Store one uploaded file, through the same ingestion path the directory indexer uses.
 *
 * Refusals are a discriminated union rather than exceptions, so a caller has to handle the
 * upload it could not accept. The one exception left is a term validation failure, which
 * `ingestFile` throws by design and this maps to `rejected` with the message — the operator
 * uploading the file is the person who can fix a missing term, and the message names it.
 */
export async function uploadFile(
  db: Pool,
  env: "dev" | "live",
  collection: string,
  workspaceId: string,
  input: UploadInput,
  deps: IngestDeps = {},
): Promise<UploadOutcome> {
  if (input.bytes.byteLength === 0) return { ok: false, reason: "empty" };
  if (input.bytes.byteLength > input.maxBytes) return { ok: false, reason: "too_large" };
  // A `.png` reaching here would be handed to the markdown path and stored as mojibake. The
  // extension is the only thing that decides, on this surface as on the indexer's.
  const contentType = contentTypeFor(input.path);
  if (!contentType && !/\.(md|txt)$/i.test(input.path))
    return { ok: false, reason: "unsupported_type" };
  if (
    contentType &&
    !deps.extractor?.extensions.includes(contentType === "application/pdf" ? "pdf" : "docx")
  )
    return { ok: false, reason: "unsupported_type" };

  const actual = blobChecksum(input.bytes);
  if (input.checksum && input.checksum !== actual)
    return { ok: false, reason: "checksum_mismatch" };

  try {
    const r = await ingestFile(
      db,
      schemaFor(env),
      collection,
      workspaceId,
      {
        path: input.path,
        bytes: input.bytes,
        ...(input.sidecar ? { sidecar: input.sidecar } : {}),
        updatedAt: input.updatedAt ?? new Date(),
        origin: "upload",
      },
      deps,
    );
    return { ok: true, fileId: r.fileId, path: input.path, status: r.status, title: r.title };
  } catch (err) {
    // `DocumentRejected` is our own: it names the file and the missing term, and it is written
    // for the admin holding the file. Anything else is a driver or programming error whose text
    // must never reach a caller — it is logged and rethrown, not summarised.
    if (err instanceof DocumentRejected)
      return { ok: false, reason: "rejected", detail: err.message };
    console.error("[broker] upload failed", { collection, err });
    throw err;
  }
}

/** Remove an uploaded file and, by cascade, its chunks. */
export async function deleteUploadedFile(
  db: Pool,
  env: "dev" | "live",
  collection: string,
  workspaceId: string,
  fileId: string,
): Promise<{ deleted: boolean; path: string | null }> {
  // fileId is caller-controlled (a URL path segment): without the workspace_id filter, an admin
  // in one workspace could delete another workspace's file by guessing or reusing its id.
  const r = await db.query<{ path: string }>(
    `delete from ${filesTable(schemaFor(env), collection)} where id = $1 and workspace_id = $2 returning path`,
    [fileId, workspaceId],
  );
  return { deleted: r.rowCount === 1, path: r.rows[0]?.path ?? null };
}

/** The stored original, for the admin-only raw download. */
export async function readFileBlob(
  db: Pool,
  env: "dev" | "live",
  collection: string,
  workspaceId: string,
  fileId: string,
): Promise<{ bytes: Buffer; contentType: string; path: string } | null> {
  // Same reasoning as deleteUploadedFile: fileId is caller-controlled, so the workspace filter is
  // what stops a raw download from crossing into another workspace's file.
  const r = await db.query<{ blob: Buffer | null; content_type: string | null; path: string }>(
    `select blob, content_type, path from ${filesTable(schemaFor(env), collection)} where id = $1 and workspace_id = $2`,
    [fileId, workspaceId],
  );
  const row = r.rows[0];
  if (!row?.blob) return null;
  return {
    bytes: row.blob,
    contentType: row.content_type ?? "text/plain; charset=utf-8",
    path: row.path,
  };
}
