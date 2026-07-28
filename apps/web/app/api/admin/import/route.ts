import { NextRequest } from "next/server";
import { loadConfig, importCollection } from "@warehousd/broker";
import { getBroker } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";

const projectDir = process.env.WAREHOUSD_PROJECT_DIR!;
const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(req: NextRequest) {
  // Admin-only. A manager approves who may READ live data; an admin decides what live data
  // exists at all. Those are different powers and this one is the narrower.
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const form = await req.formData();
  const collection = String(form.get("collection") ?? "");
  const format = String(form.get("format") ?? "");
  const file = form.get("file");

  if (format !== "csv" && format !== "json")
    return Response.json({ ok: false, reason: "unsupported_format" }, { status: 400 });
  if (!(file instanceof File) || file.size === 0)
    return Response.json({ ok: false, reason: "no_file" }, { status: 400 });
  if (file.size > MAX_BYTES)
    return Response.json({ ok: false, reason: "file_too_large" }, { status: 413 });

  const text = await file.text();
  // env is NOT read from the cookie here: import writes data_live by definition. There is no
  // parameter that could redirect it at data_synth, and none that could redirect it away.
  const result = await importCollection(
    getBroker().pools, loadConfig(projectDir), guard.user.id, collection, { text, format });

  if (!result.ok) {
    const status = result.reason === "import_not_configured" ? 503 : 400;
    return Response.json(
      { ok: false, reason: result.reason, errors: result.errors ?? [] }, { status });
  }
  return Response.json({ ok: true, imported: result.imported, columns: result.columns });
}
