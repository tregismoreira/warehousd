import { NextRequest } from "next/server";
import {
  importCollection,
  IMPORT_FORMATS,
  IMPORT_MODES,
  type ImportFormat,
  type ImportMode,
  type ImportPayload,
  type ImportProgress,
} from "@warehousd/broker";
import { makeSheetReader } from "@warehousd/providers";
import { getBroker, getConfig } from "../../../lib/broker";
import { requireRole } from "../../../../lib/authz";

const MAX_BYTES = 5 * 1024 * 1024;

const isMode = (v: string): v is ImportMode => (IMPORT_MODES as readonly string[]).includes(v);
const isFormat = (v: string): v is ImportFormat =>
  (IMPORT_FORMATS as readonly string[]).includes(v);

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
  // Absent means `append`, so a caller that predates modes still means what it used to.
  const mode = field("mode") || "append";
  // Presence is the signal, and only the exact string counts — a stray `dryRun=false` must not
  // read as "preview", which would silently turn a real import into a no-op the admin thinks
  // succeeded. The form sends "1" or nothing.
  const dryRun = field("dryRun") === "1";
  // Opt-in, and only the exact string. A caller that does not ask for a stream gets the same
  // single JSON object it always got — the integration suite and every script included.
  const stream = field("stream") === "1";
  // Only meaningful for a workbook; ignored otherwise, exactly as the CLI's flags are.
  const sheet = field("sheet");
  const headerRow = Number(field("headerRow") || "1");
  const file = form.get("file");

  if (!isFormat(format))
    return Response.json({ ok: false, error: "unsupported_format" }, { status: 400 });
  if (!isMode(mode)) return Response.json({ ok: false, error: "unknown_mode" }, { status: 400 });
  if (!(file instanceof File) || file.size === 0)
    return Response.json({ ok: false, error: "no_file" }, { status: 400 });
  if (file.size > MAX_BYTES)
    return Response.json({ ok: false, error: "file_too_large" }, { status: 413 });

  // A workbook is bytes; CSV and JSON are text. Read as whichever the format says, because
  // decoding a zip as UTF-8 and handing it to the CSV parser reports a parse failure that names
  // the wrong thing.
  const payload: ImportPayload =
    format === "xlsx"
      ? {
          format,
          bytes: new Uint8Array(await file.arrayBuffer()),
          ...(sheet ? { sheet } : {}),
          ...(Number.isInteger(headerRow) && headerRow > 1 ? { headerRow } : {}),
        }
      : { format, text: await file.text() };

  // env is NOT read from the cookie here: import writes data_live by definition. There is no
  // parameter that could redirect it at data_synth, and none that could redirect it away.
  const run = (onProgress?: (p: ImportProgress) => void) =>
    importCollection(getBroker().pools, getConfig(), guard.user.id, collection, payload, {
      mode,
      dryRun,
      sheets: makeSheetReader(),
      ...(onProgress ? { onProgress } : {}),
    });

  if (stream) return streamed(run);

  const result = await run();

  if (!result.ok) {
    // Both mean the stack cannot serve the request right now — the file may well be fine.
    // Every other refusal is something about the payload, which is the caller's to fix.
    const status =
      result.reason === "import_not_configured" || result.reason === "taxonomy_unavailable"
        ? 503
        : 400;
    return Response.json(
      // `summary` is the aggregation the panel renders — grouped by (column, reason) with
      // complete counts. `errors` stays alongside it for the detail list and for any caller
      // written before the summary existed.
      {
        ok: false,
        error: result.reason,
        errors: result.errors ?? [],
        ...(result.summary ? { summary: result.summary } : {}),
      },
      { status },
    );
  }
  return Response.json({
    ok: true,
    mode: result.mode,
    dryRun: result.dryRun,
    // `imported` is the total the form has always shown; the three counts break it down so a
    // preview can say "4 new, 96 revised" rather than one number that hides which.
    imported: result.inserted + result.updated + result.deleted,
    inserted: result.inserted,
    updated: result.updated,
    deleted: result.deleted,
    columns: result.columns,
  });
}

/**
 * The same import, as a stream of NDJSON lines: `{"progress":…}` while it runs, then one
 * `{"result":…}`.
 *
 * A long import used to be one `fetch` and an `uploading` boolean, which for ten thousand rows is
 * a frozen button. The progress objects are the broker's own `ImportProgress` — the same shape the
 * CLI renders — so the two surfaces cannot describe the same run differently.
 *
 * Always HTTP 200: the status code is written before the first row is read, so a refusal has to
 * live in the final object. The client branches on `result.ok`, which it already did.
 */
function streamed(
  run: (onProgress?: (p: ImportProgress) => void) => Promise<ImportResultShape>,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(o)}\n`));
      // Throttled here as well as in the CLI: one line per row would make the response larger
      // than the file, and the browser reads them at a few frames a second regardless.
      let last = 0;
      try {
        const result = await run((progress) => {
          const now = Date.now();
          if (now - last < 100 && progress.done !== progress.total) return;
          last = now;
          send({ progress });
        });
        send({ result: shape(result) });
      } catch (err) {
        console.error("[web] streamed import failed", err);
        send({ result: { ok: false, error: "internal_error" } });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

type ImportResultShape = Awaited<ReturnType<typeof importCollection>>;

/** The response body, in the one shape both the streamed and the plain paths return. */
function shape(result: ImportResultShape) {
  if (!result.ok)
    return {
      ok: false as const,
      error: result.reason,
      errors: result.errors ?? [],
      ...(result.summary ? { summary: result.summary } : {}),
    };
  return {
    ok: true as const,
    mode: result.mode,
    dryRun: result.dryRun,
    imported: result.inserted + result.updated + result.deleted,
    inserted: result.inserted,
    updated: result.updated,
    deleted: result.deleted,
    columns: result.columns,
  };
}
