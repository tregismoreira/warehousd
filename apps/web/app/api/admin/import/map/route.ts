import { NextRequest } from "next/server";
import {
  IMPORT_FORMATS,
  findCollection,
  inferMapping,
  parseImport,
  renderMappingYaml,
  type ImportFormat,
  type ImportPayload,
} from "@warehousd/broker";
import { makeSheetReader } from "@warehousd/providers";
import { getConfig } from "../../../../lib/broker";
import { requireRole } from "../../../../../lib/authz";

const MAX_BYTES = 5 * 1024 * 1024;
const isFormat = (v: string): v is ImportFormat =>
  (IMPORT_FORMATS as readonly string[]).includes(v);

/**
 * The mapping step: a file's headers, and which field each one lands on.
 *
 * It exists on the server rather than in the browser because a workbook is a ZIP of XML and the
 * reader lives in @warehousd/providers, and because the inference has to be the SAME inference
 * `warehousd import map` runs — an admin who maps a sheet in the console and a dev who maps it in
 * CI must not get different answers about what `Base Salary (USD)` is.
 *
 * It reads the file and returns nothing but column names. No cell value is returned, and none is
 * stored: this is a question about the shape of a spreadsheet.
 */
export async function POST(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const form = await req.formData();
  const str = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : "";
  };
  const collection = str("collection");
  const format = str("format");
  const sheet = str("sheet");
  const headerRow = Number(str("headerRow") || "1");
  const file = form.get("file");

  if (!isFormat(format))
    return Response.json({ ok: false, error: "unsupported_format" }, { status: 400 });
  if (!(file instanceof File) || file.size === 0)
    return Response.json({ ok: false, error: "no_file" }, { status: 400 });
  if (file.size > MAX_BYTES)
    return Response.json({ ok: false, error: "file_too_large" }, { status: 413 });

  const cfg = getConfig();
  const c = findCollection(cfg, collection);
  if (!c) return Response.json({ ok: false, error: "unknown_collection" }, { status: 400 });

  const payload: ImportPayload =
    format === "xlsx"
      ? {
          format,
          bytes: new Uint8Array(await file.arrayBuffer()),
          ...(sheet ? { sheet } : {}),
          ...(Number.isInteger(headerRow) && headerRow > 1 ? { headerRow } : {}),
        }
      : { format, text: await file.text() };

  let headers: string[];
  try {
    const rows = parseImport(payload, { sheets: makeSheetReader() });
    if (rows.length === 0) return Response.json({ ok: false, error: "no_rows" }, { status: 400 });
    headers = Object.keys(rows[0]!);
  } catch (err) {
    // A parser's own message can name a sheet or a row, never a value — but it is still the
    // parser's, so it is logged and the caller gets the reason code every other route uses.
    console.error("[web] import map parse failed", { collection, err });
    return Response.json({ ok: false, error: "parse_failed" }, { status: 400 });
  }

  const mapping = inferMapping(collection, c, headers);
  return Response.json({
    ok: true,
    headers,
    // Storable fields only: a view_join field is resolved from a sibling table and has no column
    // to import into, so offering it in a picker would offer a mapping the config then refuses.
    fields: Object.entries(c.fields)
      .filter(([, f]) => !f.view_join)
      .map(([name, f]) => ({ name, type: f.type ?? null, nullable: f.nullable ?? false })),
    // What the config already says, so the picker starts from the governed answer rather than
    // from a guess that would silently propose undoing it.
    configured: c.import?.columns ?? {},
    proposed: mapping.columns,
    unmatchedHeaders: mapping.unmatchedHeaders,
    missingRequired: mapping.missingRequired,
  });
}

/**
 * Turn the admin's corrected mapping into a config proposal.
 *
 * A PUT, because it is the same resource seen the other way round — and deliberately not a write.
 * `warehousd.yml` is the governed artefact: the console composes the patch and renders it, and
 * `warehousd apply` remains the only thing that commits it. That is §P4's rule, and it is the
 * property that makes the product credible rather than a convenience being withheld.
 */
export async function PUT(req: NextRequest) {
  const guard = await requireRole(req, "admin");
  if (!guard.ok) return guard.response;

  const body: unknown = await req.json();
  const { collection, columns } = (body ?? {}) as {
    collection?: unknown;
    columns?: unknown;
  };
  if (typeof collection !== "string" || typeof columns !== "object" || columns === null)
    return Response.json({ ok: false, error: "invalid_body" }, { status: 400 });

  const cfg = getConfig();
  const c = findCollection(cfg, collection);
  if (!c) return Response.json({ ok: false, error: "unknown_collection" }, { status: 400 });

  const entries = Object.entries(columns as Record<string, unknown>).filter(
    ([header, field]) => typeof field === "string" && field !== "" && header !== field,
  ) as [string, string][];

  // A mapping onto a field that does not exist is a config parse error by the time it reaches
  // `warehousd apply` (config/rules/import.ts). Catching it here means the admin finds out while
  // looking at the picker rather than a reviewer finding out in CI.
  const unknown = entries.filter(([, field]) => !Object.hasOwn(c.fields, field)).map(([h]) => h);
  if (unknown.length)
    return Response.json({ ok: false, error: "unknown_field", headers: unknown }, { status: 400 });

  return Response.json({
    ok: true,
    yaml: renderMappingYaml({
      collection,
      columns: Object.fromEntries(entries),
      unmatchedHeaders: [],
      missingRequired: [],
    }),
  });
}
