import { NextRequest } from "next/server";
import { loadConfig, regenerateSynthetic } from "@warehousd/broker";
import { getAppPool } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";

const projectDir = process.env.WAREHOUSD_PROJECT_DIR!;

export async function POST(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const { seed } = await req.json().catch(() => ({}));
  if (seed !== undefined && (typeof seed !== "number" || !Number.isFinite(seed)))
    return Response.json({ error: "invalid_seed" }, { status: 400 });

  const app = getAppPool();
  const cfg = loadConfig(projectDir);
  const { collections } = await regenerateSynthetic(app, cfg, seed ?? 42);

  // Destroying and rebuilding a whole environment is a governance event. Audited per
  // collection so the audit browser's collection filter finds it. env is the literal 'dev':
  // this operation cannot touch live, so the caller's env cookie is irrelevant here.
  for (const collection of collections) {
    await app.query(
      `insert into app.audit_events (user_id, env, collection, intent, fields_returned, outcome, reason)
       values ($1, 'dev', $2, $3, '{}', 'allowed', null)`,
      [guard.user.id, collection, JSON.stringify({ op: "regen_synth", seed: seed ?? 42 })]);
  }

  return Response.json({ ok: true, collections });
}
