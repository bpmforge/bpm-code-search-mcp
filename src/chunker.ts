export interface Chunk {
  text: string;
  startLine: number; // 1-based
  endLine: number;
}

const CHUNK_LINES = 60;
const OVERLAP_LINES = 15;
const MIN_CHUNK_CHARS = 50;

/** Sliding-window line chunker. Tree-sitter AST chunking added in v0.2. */
export function chunkFile(content: string): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];

  let i = 0;
  while (i < lines.length) {
    const start = i;
    const end = Math.min(i + CHUNK_LINES - 1, lines.length - 1);
    const text = lines
      .slice(start, end + 1)
      .join("\n")
      .trim();

    if (text.length >= MIN_CHUNK_CHARS) {
      chunks.push({ text, startLine: start + 1, endLine: end + 1 });
    }

    i += CHUNK_LINES - OVERLAP_LINES;
  }

  return chunks;
}
