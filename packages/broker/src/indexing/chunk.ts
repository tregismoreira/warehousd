// Paragraph-aware chunking: greedily pack paragraphs up to `max` chars,
// carrying `overlap` chars of tail into the next chunk for context continuity.
export function chunkText(content: string, opts: { max?: number; overlap?: number } = {}): string[] {
  const max = opts.max ?? 1000;
  const overlap = opts.overlap ?? 100;
  const paras = content.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

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
