import { describe, it, expect } from "vitest";
import { chunkFile } from "../chunker.js";

describe("chunkFile", () => {
  it("returns empty array for blank content", () => {
    expect(chunkFile("")).toEqual([]);
    expect(chunkFile("   \n  ")).toEqual([]);
  });

  it("returns a single chunk for short files", () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const chunks = chunkFile(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(20);
  });

  it("produces overlapping chunks for long files", () => {
    const content = Array.from(
      { length: 120 },
      (_, i) => `const x${i} = ${i};`,
    ).join("\n");
    const chunks = chunkFile(content);
    expect(chunks.length).toBeGreaterThan(1);
    // Overlap: end of chunk N should overlap start of chunk N+1
    const c1End = chunks[0].endLine;
    const c2Start = chunks[1].startLine;
    expect(c2Start).toBeLessThan(c1End);
  });

  it("line numbers are 1-based", () => {
    // Content must exceed MIN_CHUNK_CHARS (50) to produce a chunk
    const content = Array.from(
      { length: 5 },
      (_, i) => `const value${i} = ${i * 10};`,
    ).join("\n");
    const [chunk] = chunkFile(content);
    expect(chunk.startLine).toBe(1);
  });

  it("chunk text matches the lines", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
    const [chunk] = chunkFile(lines.join("\n"));
    for (const line of lines) {
      expect(chunk.text).toContain(line);
    }
  });
});
