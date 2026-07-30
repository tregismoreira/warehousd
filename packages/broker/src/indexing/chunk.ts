const DEFAULT_OVERLAP = 100;

// Undo chunkText's overlap: each chunk after the first begins with a slice of the previous
// chunk's tail, so the join is the longest suffix/prefix match within the overlap window.
//
// This reconstructs the *chunked* text, not the source file byte-for-byte — chunkText trims
// paragraphs and rejoins them with "\n\n", and that normalization is not reversible. Nothing
// stores the original body, so this is the best a full-document read can do today. Callers
// that need the exact source must keep it themselves.
export function reassembleChunks(chunks: string[], opts: { overlap?: number } = {}): string {
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;
  if (chunks.length === 0) return "";
  let out = chunks[0]!;
  for (const next of chunks.slice(1)) {
    const window = Math.min(overlap, out.length, next.length);
    let matched = 0;
    for (let n = window; n > 0; n--) {
      if (out.endsWith(next.slice(0, n))) {
        matched = n;
        break;
      }
    }
    out += next.slice(matched);
  }
  return out;
}

// Paragraph-aware chunking: greedily pack paragraphs up to `max` chars,
// carrying `overlap` chars of tail into the next chunk for context continuity.
export function chunkText(
  content: string,
  opts: { max?: number; overlap?: number } = {},
): string[] {
  const max = opts.max ?? 1000;
  const overlap = opts.overlap ?? 100;
  const paras = content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paras.length === 0) return [];

  const chunks: string[] = [];
  let current = "";

  for (const para of paras) {
    // If the paragraph itself is oversized, hard-split it
    if (para.length > max) {
      // Flush current chunk if it has content
      if (current) {
        chunks.push(current);
      }

      // Hard-split the oversized paragraph into max-sized pieces
      let remaining = para;
      while (remaining.length > max) {
        chunks.push(remaining.slice(0, max));
        // Start next chunk with overlap from the tail of what we just pushed
        remaining = remaining.slice(max - overlap);
      }

      // Set current to the remaining part (will be combined with next para if it fits)
      current = remaining;
    } else {
      // Try to fit the paragraph into current chunk
      if (current.length === 0) {
        current = para;
      } else if (current.length + 2 + para.length <= max) {
        // Fits with paragraph separator
        current = `${current}\n\n${para}`;
      } else {
        // Doesn't fit; flush current and start new chunk with overlap
        chunks.push(current);
        // Carry overlap into the next chunk
        const tailStart = Math.max(0, current.length - overlap);
        current = current.slice(tailStart);
        // Add the new paragraph
        if (current.length + 2 + para.length <= max) {
          current = `${current}\n\n${para}`;
        } else {
          // Overlap + separator + para still doesn't fit; just start fresh with para
          current = para;
        }
      }
    }
  }

  // Flush any remaining content
  if (current) {
    chunks.push(current);
  }

  return chunks;
}
