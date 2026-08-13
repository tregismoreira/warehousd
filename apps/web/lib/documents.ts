import {
  findCollection,
  loadTaxonomyBindings,
  fileMetadataFields,
  auditEnabled,
  auditDestination,
  makeAuditWriter,
  type WarehousdConfig,
  type TaxonomyBinding,
  type MetadataField,
  type Embedder,
} from "@warehousd/broker";
import { makeBinaryExtractor, makeEmbedder } from "@warehousd/providers";
import type { Pool } from "pg";

/** 25 MB unless the operator says otherwise. A governed document, not a video. */
export function maxUploadBytes(): number {
  const raw = Number(process.env.WAREHOUSD_MAX_UPLOAD_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 25 * 1024 * 1024;
}

export function isEnv(v: unknown): v is "dev" | "live" {
  return v === "dev" || v === "live";
}

/**
 * Everything one upload needs, resolved once per request.
 *
 * The extractor and the embedder are constructed HERE and injected, the same way `getBroker`
 * injects the embedder — `packages/broker` declares the interfaces and never imports a PDF
 * parser or an ONNX runtime.
 */
export async function ingestDepsFor(
  app: Pool,
  cfg: WarehousdConfig,
  collection: string,
  env: "dev" | "live",
  workspaceId: string,
): Promise<
  | { ok: true; taxonomies: TaxonomyBinding[]; metadata: MetadataField[]; embedder?: Embedder }
  | { ok: false; error: "unknown_collection" | "not_a_file_collection" }
> {
  const c = findCollection(cfg, collection);
  if (!c) return { ok: false, error: "unknown_collection" };
  if (c.type !== "file") return { ok: false, error: "not_a_file_collection" };
  return {
    ok: true,
    taxonomies: await loadTaxonomyBindings(app, cfg, collection, env, workspaceId),
    metadata: fileMetadataFields(c),
    // Absent `embedding:` leaves chunks with a null embedding, exactly as the indexer does.
    // `warehousd embed` can fill them in later; nothing is lost, and the upload does not fail
    // because a model is unreachable.
    ...(cfg.embedding ? { embedder: makeEmbedder(cfg.embedding) } : {}),
  };
}

export const binaryExtractor = makeBinaryExtractor();

/**
 * One audit row per document that arrives, changes or leaves.
 *
 * An admin deciding what live content exists is a governance event on the same footing as an
 * import, and the audit browser's collection filter has to find it. Written through the app
 * pool because this is an operator action, not a governed read.
 *
 * Through `makeAuditWriter`, not a hand-written insert — the hand-written version left
 * workspace_id at its table default regardless of which workspace's admin uploaded, downloaded
 * or deleted the document, the same class of bug the regen-synth and embed routes' own comments
 * describe fixing.
 */
export async function auditDocument(
  app: Pool,
  cfg: WarehousdConfig,
  userId: string,
  workspaceId: string,
  env: "dev" | "live",
  collection: string,
  intent: { op: string } & Record<string, unknown>,
): Promise<void> {
  const writer = makeAuditWriter(
    app,
    { userId, workspaceId, env, allowedCollections: null, via: "session" },
    auditEnabled(cfg),
    auditDestination(cfg),
  );
  await writer.allow(collection, { intent });
}
