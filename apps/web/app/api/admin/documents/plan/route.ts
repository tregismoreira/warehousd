import { NextRequest } from "next/server";
import { planUpload, findCollection } from "@warehousd/broker";
import { getAppPool, getConfig } from "../../../../lib/broker";
import { requireRole } from "../../../../../lib/authz";
import { isEnv } from "../../../../../lib/documents";

/** Enough to plan a whole corpus in one round trip, not enough to be a memory attack. */
const MAX_ENTRIES = 5000;

/**
 * "Which of these do you already have?" — the entire resume mechanism.
 *
 * The client hashes each file locally, asks this, and uploads only what comes back `new` or
 * `changed`. Nothing about the answer depends on what the client remembers from a previous
 * session, so a pause of any length — a closed tab, a different machine, a crash — resumes
 * exactly where it stopped, and re-running a finished upload transfers nothing.
 */
export async function POST(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const body: unknown = await req.json().catch(() => null);
  if (typeof body !== "object" || body === null)
    return Response.json({ error: "invalid_body" }, { status: 400 });
  const { collection, env, files } = body as Record<string, unknown>;

  if (typeof collection !== "string" || !collection)
    return Response.json({ error: "invalid_collection" }, { status: 400 });
  if (!isEnv(env)) return Response.json({ error: "invalid_env" }, { status: 400 });
  if (!Array.isArray(files)) return Response.json({ error: "invalid_files" }, { status: 400 });
  if (files.length > MAX_ENTRIES)
    return Response.json({ error: "too_many_files" }, { status: 400 });

  const entries: { path: string; checksum: string }[] = [];
  for (const f of files) {
    if (typeof f !== "object" || f === null)
      return Response.json({ error: "invalid_files" }, { status: 400 });
    const { path, checksum } = f as Record<string, unknown>;
    // A hex sha256 or nothing. A malformed one would silently plan as `changed` and re-upload
    // the whole corpus every time, which looks like the feature working and is not.
    if (typeof path !== "string" || !path || typeof checksum !== "string")
      return Response.json({ error: "invalid_files" }, { status: 400 });
    if (!/^[0-9a-f]{64}$/.test(checksum))
      return Response.json({ error: "invalid_checksum" }, { status: 400 });
    entries.push({ path, checksum });
  }

  const cfg = getConfig();
  const c = findCollection(cfg, collection);
  if (!c) return Response.json({ error: "unknown_collection" }, { status: 404 });
  if (c.type !== "file") return Response.json({ error: "not_a_file_collection" }, { status: 400 });

  const plan = await planUpload(getAppPool(), env, collection, entries);
  return Response.json({ ok: true, plan });
}
