import { NextRequest } from "next/server";
import { importCollection } from "@warehousd/broker";
import { getBroker, getConfig } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";

const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(req: NextRequest) {
  // Admin-only. A manager approves who may READ live data; an admin decides what live data
  // exists at all. Those are different powers and this one is the narrower.
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  // Failures carry `error`, matching every other route under /api. This one used `reason`, and
  // was the only console endpoint that did — a client could not read one field to find out what
  // went wrong. `ok` and `errors` stay: the success shape is a union the form branches on, and
  // per-row validation detail has no slot in rest.ts's `refuse`.
  const form = await req.formData();
  // `FormData.get` returns `string | File`, so `String(...)` on a part the client uploaded as a
  // file yielded the literal "[object File]" — a collection name that then failed lookup as
  // `unknown_collection` rather than as the bad request it was. Read only the string form.
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : "";
  };
  const collection = field("collection");
  const format = field("format");
  const file = form.get("file");

  if (format !== "csv" && format !== "json")
    return Response.json({ ok: false, error: "unsupported_format" }, { status: 400 });
  if (!(file instanceof File) || file.size === 0)
    return Response.json({ ok: false, error: "no_file" }, { status: 400 });
  if (file.size > MAX_BYTES)
    return Response.json({ ok: false, error: "file_too_large" }, { status: 413 });

  const text = await file.text();
  // env is NOT read from the cookie here: import writes data_live by definition. There is no
  // parameter that could redirect it at data_synth, and none that could redirect it away.
  const result = await importCollection(getBroker().pools, getConfig(), guard.user.id, collection, {
    text,
    format,
  });

  if (!result.ok) {
    // Both mean the stack cannot serve the request right now — the file may well be fine.
    // Every other refusal is something about the payload, which is the caller's to fix.
    const status =
      result.reason === "import_not_configured" || result.reason === "taxonomy_unavailable"
        ? 503
        : 400;
    return Response.json(
      { ok: false, error: result.reason, errors: result.errors ?? [] },
      { status },
    );
  }
  return Response.json({ ok: true, imported: result.imported, columns: result.columns });
}
