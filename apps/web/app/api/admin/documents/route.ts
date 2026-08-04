import { NextRequest } from "next/server";
import { uploadFile } from "@warehousd/broker";
import { getAppPool, getConfig } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";
import {
  ingestDepsFor,
  binaryExtractor,
  maxUploadBytes,
  isEnv,
  auditDocument,
} from "../../../../lib/documents";

/**
 * One file per request.
 *
 * Deliberately not a batch: a request that carries fifty files either succeeds or fails as a
 * unit, and a failure halfway through leaves the client guessing which half landed. One file
 * per request makes every outcome individually observable, lets the client retry exactly what
 * failed, and lets it run several in parallel — which is also what makes it fast.
 */
export async function POST(req: NextRequest) {
  // Admin-only. A manager approves who may READ live data; an admin decides what live data
  // exists at all. Those are different powers and this one is the narrower.
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const form = await req.formData().catch(() => null);
  if (!form) return Response.json({ error: "invalid_body" }, { status: 400 });
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : "";
  };

  const collection = field("collection");
  const env = field("env");
  // The path is the file's identity within the collection, and re-uploading the same path is a
  // revision of that document rather than a second copy. A directory upload sends the browser's
  // relative path so the folder structure survives.
  const rawPath = field("path");
  const checksum = field("checksum");
  const file = form.get("file");

  if (!collection) return Response.json({ error: "invalid_collection" }, { status: 400 });
  if (!isEnv(env)) return Response.json({ error: "invalid_env" }, { status: 400 });
  if (!(file instanceof File)) return Response.json({ error: "no_file" }, { status: 400 });

  const path = normalizePath(rawPath || file.name);
  if (!path) return Response.json({ error: "invalid_path" }, { status: 400 });

  const app = getAppPool();
  const cfg = getConfig();
  const deps = await ingestDepsFor(app, cfg, collection, env);
  if (!deps.ok)
    return Response.json(
      { error: deps.error },
      { status: deps.error === "unknown_collection" ? 404 : 400 },
    );

  // Owner, terms and typed metadata: the form's stand-in for the sidecar YAML the directory
  // indexer reads. Sent as one JSON object so a multi-value vocabulary keeps its array.
  let sidecar: Record<string, unknown> = {};
  const rawSidecar = field("sidecar");
  if (rawSidecar) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawSidecar);
    } catch {
      return Response.json({ error: "invalid_sidecar" }, { status: 400 });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return Response.json({ error: "invalid_sidecar" }, { status: 400 });
    sidecar = parsed as Record<string, unknown>;
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const result = await uploadFile(
    app,
    env,
    collection,
    {
      path,
      bytes,
      checksum: checksum || undefined,
      sidecar,
      maxBytes: maxUploadBytes(),
    },
    {
      taxonomies: deps.taxonomies,
      metadata: deps.metadata,
      extractor: binaryExtractor,
      embedder: deps.embedder,
    },
  );

  if (!result.ok) {
    const status =
      result.reason === "too_large" ? 413 : result.reason === "unknown_collection" ? 404 : 400;
    return Response.json(
      { error: result.reason, ...(result.detail ? { detail: result.detail } : {}) },
      { status },
    );
  }

  // A skipped file is not a no-op worth hiding: the client counts it as done, and the audit
  // trail records that the upload happened and changed nothing.
  await auditDocument(app, cfg, guard.user.id, env, collection, {
    op: "document:upload",
    path,
    fileId: result.fileId,
    bytes: bytes.byteLength,
    result: result.status,
  });

  return Response.json({
    ok: true,
    fileId: result.fileId,
    path: result.path,
    title: result.title,
    status: result.status,
  });
}

/**
 * A browser's `webkitRelativePath` is `Folder/sub/file.pdf`. Everything that could make it name
 * something outside the collection is refused rather than rewritten — a rewritten path is one
 * an admin cannot recognise later.
 */
function normalizePath(raw: string): string | null {
  const p = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p || p.length > 1024) return null;
  if (p.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  // Control characters would make a path that cannot be typed, searched for, or safely logged.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return null;
  return p;
}
