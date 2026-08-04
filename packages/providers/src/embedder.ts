import type { Embedder } from "@warehousd/broker";
import { importRuntime } from "./runtime-import";

// The two embedders, and the reason they live here rather than in the broker.
//
// `local` needs an ONNX runtime and a model on disk. `remote` makes an outbound HTTP call and
// sends document text to a third party. Neither belongs inside a package whose defining property
// is that it has no HTTP, no LLM dependency, and nothing to configure. The broker declares
// `Embedder` and consumes it; this is where the awkward parts live.
//
// The default is `local` on purpose. warehousd's pitch is that governed data does not leave the
// deployment, and an embedding request is the whole document text. Sending it to an API is a
// legitimate choice — a better model is a better search — but it is a choice someone has to make
// in writing, in warehousd.yml, rather than one they inherit from a default.

export class EmbeddingFailed extends Error {}

export type EmbeddingConfig = {
  provider: "local" | "openai" | "http";
  model: string;
  dimensions: number;
  base_url?: string | undefined;
  api_key?: string | undefined;
};

/**
 * A local ONNX model, run in-process. Keeps `warehousd start` working with no network, which the
 * README promises, and keeps document text on the machine that holds the documents.
 *
 * The model is loaded once, lazily, on the first embed — importing this module must stay free, or
 * every CLI command pays for a runtime that most of them never use.
 */
export function localEmbedder(cfg: EmbeddingConfig): Embedder {
  let pipe: Promise<unknown> | null = null;
  const load = async () => {
    let transformers: typeof import("@huggingface/transformers");
    try {
      transformers = await importRuntime<typeof import("@huggingface/transformers")>(
        "@huggingface/transformers",
      );
    } catch {
      throw new EmbeddingFailed(
        "local embedding needs @huggingface/transformers — install it, or set embedding.provider to openai/http",
      );
    }
    // WAREHOUSD_MODEL_DIR points at model files baked into the Docker image at build time. Without
    // it the library would reach for the network on first use, which is exactly the behaviour the
    // local provider exists to avoid — so a deployment that has not baked a model fails loudly on
    // the first embed rather than quietly phoning home.
    const localDir = process.env.WAREHOUSD_MODEL_DIR;
    if (localDir) {
      transformers.env.localModelPath = localDir;
      transformers.env.allowRemoteModels = false;
    }
    return transformers.pipeline("feature-extraction", cfg.model);
  };

  return {
    dimensions: cfg.dimensions,
    async embed(texts) {
      if (!texts.length) return [];
      pipe ??= load();
      const extractor = (await pipe) as (
        t: string[],
        o: Record<string, unknown>,
      ) => Promise<{ tolist(): number[][] }>;
      // Mean pooling over tokens, then L2 — the standard recipe for sentence-transformers
      // models, and what makes cosine distance meaningful in pgvector.
      const out = await extractor(texts, { pooling: "mean", normalize: true });
      const vectors = out.tolist();
      for (const v of vectors) assertWidth(v, cfg.dimensions);
      return vectors;
    },
  };
}

/**
 * Any OpenAI-compatible `/embeddings` endpoint. `provider: openai` is this with a default
 * base_url; `provider: http` is the same thing pointed at something you run.
 */
export function remoteEmbedder(cfg: EmbeddingConfig): Embedder {
  const base = (cfg.base_url ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return {
    dimensions: cfg.dimensions,
    async embed(texts) {
      if (!texts.length) return [];
      let res: Response;
      try {
        res = await fetch(`${base}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(cfg.api_key ? { authorization: `Bearer ${cfg.api_key}` } : {}),
          },
          body: JSON.stringify({ model: cfg.model, input: texts }),
        });
      } catch {
        // No cause, no URL with a key in it, and above all no `texts`. This message reaches a
        // log line, and the input is document content.
        throw new EmbeddingFailed("embedding request failed to reach the provider");
      }
      if (!res.ok) throw new EmbeddingFailed(`embedding provider returned ${res.status}`);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new EmbeddingFailed("embedding provider returned a malformed body");
      }
      const data = (body as { data?: { embedding?: unknown }[] }).data;
      if (!Array.isArray(data) || data.length !== texts.length)
        throw new EmbeddingFailed("embedding provider returned the wrong number of vectors");
      return data.map((d) => {
        const v = d.embedding;
        if (!Array.isArray(v) || v.some((x) => typeof x !== "number"))
          throw new EmbeddingFailed("embedding provider returned a malformed vector");
        assertWidth(v as number[], cfg.dimensions);
        return v as number[];
      });
    },
  };
}

export function makeEmbedder(cfg: EmbeddingConfig): Embedder {
  return cfg.provider === "local" ? localEmbedder(cfg) : remoteEmbedder(cfg);
}

// A width mismatch surfaces from Postgres as "expected N dimensions, not M" on the insert, which
// names neither the model nor the config key that is wrong. Catch it where both are in scope.
function assertWidth(v: number[], expected: number): void {
  if (v.length !== expected)
    throw new EmbeddingFailed(
      `model returned ${v.length}-dimensional vectors but embedding.dimensions is ${expected}`,
    );
}
