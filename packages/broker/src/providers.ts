// The two capabilities the broker consumes but must not contain.
//
// Semantic search needs to turn text into a vector, and indexing a PDF needs to turn bytes into
// text. Both wants pull in something heavy — an ONNX runtime, a PDF parser — and the remote
// embedder wants an outbound HTTP call. Putting any of that in `packages/broker` would trade away
// the one property the package exists to have: it is a pure library with no HTTP, MCP, UI or LLM
// dependency, independently testable, and small enough to read.
//
// So the broker declares the contract and consumes it; `@warehousd/providers` implements it, and
// the adapters (apps/web, packages/cli) inject the implementation. Exactly how `Pools` already
// works — the broker has never opened its own database connection either.
//
// The practical payoff beyond purity: every test in this repo can supply a deterministic stub
// instead of downloading a 100MB model, and a suite asserting that grant scoping holds under
// semantic search does not become a suite that also needs a working ONNX runtime.

/** Turns text into vectors. One call per batch; the caller decides batch size. */
export type Embedder = {
  /**
   * Must match the `embedding.dimensions` the collection's vector column was created with. Held
   * against the config at construction time rather than at query time, because a mismatch
   * surfaces from Postgres as a cast error with no indication of which side is wrong.
   */
  readonly dimensions: number;
  /** Vectors are returned in input order, one per input, already L2-normalised. */
  embed(texts: string[]): Promise<number[][]>;
};

/** What an extractor made of a file: the text to index, plus whatever metadata it could recover. */
export type ExtractedText = {
  text: string;
  /** From the document's own metadata when it has any — a PDF title, a DOCX core property. */
  title?: string | undefined;
  /** Page or paragraph count, for the file inventory. Absent when the format does not say. */
  pages?: number | undefined;
};

/** Turns the bytes of a supported binary document into indexable text. */
export type BinaryExtractor = {
  /** Lower-case extensions this extractor handles, without the dot: `["pdf", "docx"]`. */
  readonly extensions: readonly string[];
  /**
   * Rejects with a typed error rather than a library stack trace on a corrupt or truncated file:
   * the indexer reports which file failed, and a parser's internals are not something a caller
   * should ever see.
   */
  extract(filename: string, bytes: Uint8Array): Promise<ExtractedText>;
};

/** Raised by an extractor for a file it cannot read. Carries no library detail. */
export class ExtractionFailed extends Error {
  constructor(
    readonly filename: string,
    reason: string,
  ) {
    super(`${filename}: ${reason}`);
    this.name = "ExtractionFailed";
  }
}
