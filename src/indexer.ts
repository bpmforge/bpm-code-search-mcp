import fs from "fs";
import path from "path";
import { glob } from "glob";
import { chunkFile } from "./chunker/index.js";
import { CodeSearchDb } from "./db.js";
import type { EmbeddingProvider } from "./embeddings/index.js";
import { extractSymbols } from "./symbols/extractor.js";

const BATCH_SIZE = 32;

const DEFAULT_INCLUDE = [
  "**/*.ts",
  "**/*.tsx",
  "**/*.js",
  "**/*.jsx",
  "**/*.mjs",
  "**/*.cjs",
  "**/*.py",
  "**/*.rs",
  "**/*.go",
  "**/*.java",
  "**/*.cs",
  "**/*.cpp",
  "**/*.c",
  "**/*.h",
  "**/*.rb",
  "**/*.php",
  "**/*.swift",
  "**/*.kt",
  "**/*.md",
  "**/*.mdx",
];

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
  "**/coverage/**",
  "**/*.min.js",
  "**/*.map",
];

export interface IndexResult {
  indexed: number;
  skipped: number;
  errors: string[];
}

export async function indexPath(
  rootPath: string,
  db: CodeSearchDb,
  provider: EmbeddingProvider,
  options: { include?: string[]; ignore?: string[] } = {},
): Promise<IndexResult> {
  const include = options.include ?? DEFAULT_INCLUDE;
  const ignore = options.ignore ?? DEFAULT_IGNORE;

  const files = await glob(include, {
    cwd: rootPath,
    ignore,
    absolute: true,
    nodir: true,
  });

  let indexed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      const mtime = Math.floor(stat.mtimeMs);
      const stored = db.getFileMtime(filePath);

      if (stored === mtime) {
        skipped++;
        continue;
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const chunks = await chunkFile(content, filePath);

      db.deleteFile(filePath);

      // Symbol extraction — runs for all indexed files regardless of chunk count
      const symbols = extractSymbols(content, filePath);
      if (symbols.length > 0) {
        db.insertSymbols(
          symbols.map((s) => ({ ...s, filePath, fileMtime: mtime })),
        );
      }

      if (chunks.length === 0) {
        skipped++;
        continue;
      }

      // Embed in batches
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const embeddings = await provider.embed(batch.map((c) => c.text));

        db.insertChunks(
          batch.map((chunk, j) => ({
            filePath,
            chunkText: chunk.text,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            fileMtime: mtime,
            embeddingProvider: provider.name,
            embedding: new Float32Array(embeddings[j]),
            // Symbols declared within this chunk's line range populate the
            // FTS5 symbols/subtokens columns (BM25F weighting — see db.ts).
            symbols: symbols
              .filter(
                (s) => s.line >= chunk.startLine && s.line <= chunk.endLine,
              )
              .map((s) => s.name),
          })),
        );
      }

      indexed++;
    } catch (err) {
      errors.push(
        `${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { indexed, skipped, errors };
}
