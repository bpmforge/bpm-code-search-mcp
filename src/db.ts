import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { ProviderMeta } from "./embeddings/index.js";

export interface Chunk {
  id: number;
  filePath: string;
  chunkText: string;
  startLine: number;
  endLine: number;
  fileMtime: number;
  embeddingProvider: string;
}

export interface SearchResult extends Chunk {
  score: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path         TEXT    NOT NULL,
  chunk_text        TEXT    NOT NULL,
  start_line        INTEGER NOT NULL,
  end_line          INTEGER NOT NULL,
  file_mtime        INTEGER NOT NULL,
  embedding_provider TEXT   NOT NULL,
  embedding         BLOB    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_chunks_mtime ON chunks(file_path, file_mtime);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_text,
  content=chunks,
  content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, chunk_text) VALUES (new.id, new.chunk_text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, chunk_text) VALUES ('delete', old.id, old.chunk_text);
END;
`;

export class CodeSearchDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
  }

  getProviderMeta(): ProviderMeta | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get("provider") as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  setProviderMeta(meta: ProviderMeta): void {
    this.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run("provider", JSON.stringify(meta));
  }

  getFileMtime(filePath: string): number | null {
    const row = this.db
      .prepare("SELECT file_mtime FROM chunks WHERE file_path = ? LIMIT 1")
      .get(filePath) as { file_mtime: number } | undefined;
    return row?.file_mtime ?? null;
  }

  deleteFile(filePath: string): void {
    this.db.prepare("DELETE FROM chunks WHERE file_path = ?").run(filePath);
  }

  insertChunks(
    chunks: Array<{
      filePath: string;
      chunkText: string;
      startLine: number;
      endLine: number;
      fileMtime: number;
      embeddingProvider: string;
      embedding: Float32Array;
    }>,
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO chunks
         (file_path, chunk_text, start_line, end_line, file_mtime, embedding_provider, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMany = this.db.transaction((rows: typeof chunks) => {
      for (const row of rows) {
        insert.run(
          row.filePath,
          row.chunkText,
          row.startLine,
          row.endLine,
          row.fileMtime,
          row.embeddingProvider,
          Buffer.from(row.embedding.buffer),
        );
      }
    });
    insertMany(chunks);
  }

  /** Brute-force cosine similarity scan — fine for <50k chunks. */
  search(queryEmbedding: Float32Array, topK: number): SearchResult[] {
    const rows = this.db
      .prepare(
        `SELECT id, file_path, chunk_text, start_line, end_line, file_mtime,
                embedding_provider, embedding FROM chunks`,
      )
      .all() as Array<{
      id: number;
      file_path: string;
      chunk_text: string;
      start_line: number;
      end_line: number;
      file_mtime: number;
      embedding_provider: string;
      embedding: Buffer;
    }>;

    const scored = rows.map((row) => {
      const vec = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
      const score = cosineSimilarity(queryEmbedding, vec);
      return {
        id: row.id,
        filePath: row.file_path,
        chunkText: row.chunk_text,
        startLine: row.start_line,
        endLine: row.end_line,
        fileMtime: row.file_mtime,
        embeddingProvider: row.embedding_provider,
        score,
      };
    });

    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /** FTS5 fallback when no embedding provider is available. */
  searchFts(query: string, topK: number): SearchResult[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.file_path, c.chunk_text, c.start_line, c.end_line,
                c.file_mtime, c.embedding_provider,
                bm25(chunks_fts) AS score
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY score
         LIMIT ?`,
      )
      .all(query, topK) as Array<{
      id: number;
      file_path: string;
      chunk_text: string;
      start_line: number;
      end_line: number;
      file_mtime: number;
      embedding_provider: string;
      score: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      filePath: row.file_path,
      chunkText: row.chunk_text,
      startLine: row.start_line,
      endLine: row.end_line,
      fileMtime: row.file_mtime,
      embeddingProvider: row.embedding_provider,
      score: -row.score, // bm25 returns negative values (lower = better match)
    }));
  }

  chunkCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as n FROM chunks").get() as {
      n: number;
    };
    return row.n;
  }

  fileCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(DISTINCT file_path) as n FROM chunks")
      .get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
