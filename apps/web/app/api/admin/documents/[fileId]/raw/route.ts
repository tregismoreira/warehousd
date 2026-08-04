import { NextRequest } from "next/server";
import { readFileBlob, findCollection } from "@warehousd/broker";
import { getAppPool, getConfig } from "../../../../../lib/broker";
import { requireRole } from "../../../../../../lib/authz";
import { isEnv, auditDocument } from "../../../../../../lib/documents";

/**
 * The stored original, byte for byte.
 *
 * Admin-only and audited, because this is the one path that returns a document's *whole*
 * content outside the governed read path — no field postures apply to a PDF's bytes, and no
 * grant scopes them. An admin already decides what live content exists; this lets them see what
 * they are deciding about, and leaves a row saying they did.
 *
 * Served as an attachment with a fixed content type from the stored value, never from anything
 * a caller supplies: an inline HTML response from an uploaded file would run in the console's
 * own origin.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ fileId: string }> }) {
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
  if (c.type !== "file") return Response.json({ error: "not_a_file_collection" }, { status: 400 });

  const app = getAppPool();
  const stored = await readFileBlob(app, env, collection, fileId);
  if (!stored) return Response.json({ error: "not_found" }, { status: 404 });

  await auditDocument(app, cfg, guard.user.id, env, collection, {
    op: "document:download",
    fileId,
    path: stored.path,
  });

  // The filename is derived from the stored path and quoted; a path with a quote in it cannot
  // exist (normalizePath refuses control characters, and a quote is escaped here).
  const name = stored.path.split("/").pop() ?? "document";
  return new Response(new Uint8Array(stored.bytes), {
    headers: {
      "content-type": stored.contentType,
      "content-length": String(stored.bytes.byteLength),
      "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
      // Nothing derived from an uploaded file should be sniffed into another type.
      "x-content-type-options": "nosniff",
    },
  });
}
