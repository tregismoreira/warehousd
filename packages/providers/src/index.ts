// Concrete implementations of the capability interfaces `packages/broker` declares.
//
// The split exists so the broker stays a pure library: it says what an Embedder and a
// BinaryExtractor are, and this package is where the ONNX runtime, the PDF parser and the
// outbound HTTP call actually live. Adapters (apps/web, packages/cli) construct from here and
// inject downwards — the same direction `Pools` already flows.
export { makeBinaryExtractor } from "./extract-binary";
export { importRuntime } from "./runtime-import";
export {
  makeEmbedder,
  localEmbedder,
  remoteEmbedder,
  EmbeddingFailed,
  type EmbeddingConfig,
} from "./embedder";
