import { NextRequest } from "next/server";
import { embedCollection, auditEnabled, kindOf } from "@warehousd/broker";
import { makeEmbedder } from "@warehousd/providers";
import { getAppPool, getConfig } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";
import { isEnv } from "../../../../lib/documents";

/**
 * Fill the embedding column for file collections, from the console.
 *
 * The same operation `warehousd embed` performs, and the same guarantee: it only ever touches
 * chunks that have no embedding, so pressing it twice costs nothing and pressing it after an
 * interrupted run resumes rather than restarts. Uploads embed inline when `embedding:` is
 * configured, so this is for a corpus that predates the config or a run a rate limit cut short.
 */
export async function POST(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const body: unknown = await req.json().catch(() => ({}));
  const { collection, env } = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  if (!isEnv(env)) return Response.json({ error: "invalid_env" }, { status: 400 });
  if (collection !== undefined && typeof collection !== "string")
    return Response.json({ error: "invalid_collection" }, { status: 400 });

  const cfg = getConfig();
  // Saying so beats doing nothing and reporting success: an admin who presses this because
  // semantic search returns nothing needs to be told the config is what is missing.
  if (!cfg.embedding) return Response.json({ error: "embedding_not_configured" }, { status: 400 });

  const names = collection
    ? [collection]
    : Object.entries(cfg.collections)
        .filter(([, c]) => kindOf(c).chunked)
        .map(([n]) => n);
  for (const n of names) {
    const c = cfg.collections[n];
    if (!c) return Response.json({ error: "unknown_collection" }, { status: 404 });
    if (!kindOf(c).chunked)
      return Response.json({ error: "not_a_file_collection" }, { status: 400 });
  }

  const app = getAppPool();
  const embedder = makeEmbedder(cfg.embedding);
  let embedded = 0;
  for (const n of names) embedded += (await embedCollection(app, env, n, embedder)).embedded;

  for (const n of auditEnabled(cfg) ? names : [])
    await app.query(
      `insert into app.audit_events (user_id, env, collection, intent, fields_returned, outcome, reason)
       values ($1, $2, $3, $4, '{}', 'allowed', null)`,
      [guard.user.id, env, n, JSON.stringify({ op: "embed", embedded })],
    );

  return Response.json({ ok: true, embedded, collections: names });
}
