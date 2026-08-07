import { NextRequest } from "next/server";
import { deleteUploadedFile, findCollection, kindOf } from "@warehousd/broker";
import { getAppPool, getConfig } from "../../../../lib/broker";
import { requireRole } from "../../../../../lib/authz";
import { isEnv, auditDocument } from "../../../../../lib/documents";

/**
 * Remove a document and its chunks.
 *
 * Physical, not a revision: `{c}__files` is a mirror of source material, not a revisioned
 * dataset, and the collection is rebuilt from the source directory or re-uploaded. The audit
 * row is what survives, and it names the path so "what was that?" has an answer.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ fileId: string }> }) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const { fileId } = await ctx.params;
  const url = new URL(req.url);
  const collection = url.searchParams.get("collection") ?? "";
  const env = url.searchParams.get("env") ?? "";

  if (!collection) return Response.json({ error: "invalid_collection" }, { status: 400 });
  if (!isEnv(env)) return Response.json({ error: "invalid_env" }, { status: 400 });
  if (!/^[0-9a-fA-F-]{36}$/.test(fileId))
    return Response.json({ error: "invalid_file_id" }, { status: 400 });

  const cfg = getConfig();
  const c = findCollection(cfg, collection);
  if (!c) return Response.json({ error: "unknown_collection" }, { status: 404 });
  if (!kindOf(c).chunked) return Response.json({ error: "not_a_file_collection" }, { status: 400 });

  const app = getAppPool();
  const { deleted, path } = await deleteUploadedFile(app, env, collection, fileId);
  if (!deleted) return Response.json({ error: "not_found" }, { status: 404 });

  await auditDocument(app, cfg, guard.user.id, env, collection, {
    op: "document:delete",
    fileId,
    path,
  });
  return Response.json({ ok: true, path });
}
