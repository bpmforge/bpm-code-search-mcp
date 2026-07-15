import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import path from "path";
import fs from "fs";
import type { ProviderMeta } from "./embeddings/index.js";
import type { CodeSymbol, SymbolKind } from "./symbols/extractor.js";

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

export interface SymbolRow {
  filePath: string;
  name: string;
  kind: SymbolKind;
  line: number;
  signature: string;
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

CREATE TABLE IF NOT EXISTS symbols (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path  TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  line       INTEGER NOT NULL,
  signature  TEXT    NOT NULL,
  file_mtime INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
`;

export class CodeSearchDb {
  private db: Database.Database;
  /** True when the sqlite-vec ANN extension loaded (falls back to brute force if not). */
  private vecEnabled = false;
  /** Dimension of the current vec_chunks table, if built. */
  private vecDim: number | null = null;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA); // create tables first — the vec-dim read below needs `meta`
    // Load the sqlite-vec ANN extension. If it can't load (platform/ABI), the
    // engine still works — every vector query falls back to the brute-force
    // cosine scan. ANN is a pure speedup, never a correctness dependency.
    try {
      sqliteVec.load(this.db);
      this.vecEnabled = true;
      const row = this.db
        .prepare("SELECT value FROM meta WHERE key = 'vec_dim'")
        .get() as { value: string } | undefined;
      if (row) this.vecDim = Number(row.value);
    } catch {
      this.vecEnabled = false;
    }
  }

  get annEnabled(): boolean {
    return this.vecEnabled;
  }

  private vecTableExists(): boolean {
    return (
      this.vecEnabled &&
      !!this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name = 'vec_chunks' LIMIT 1",
        )
        .get()
    );
  }

  /**
   * Ensure the vec0 ANN table exists for `dim`. Uses cosine distance so ANN
   * scores match the brute-force cosine scan. Recreates it if the dimension
   * changed (provider swap). No-op when the extension didn't load.
   */
  private ensureVecTable(dim: number): void {
    if (!this.vecEnabled) return;
    if (this.vecDim === dim && this.vecTableExists()) return;
    if (this.vecDim !== null && this.vecDim !== dim) {
      this.db.exec("DROP TABLE IF EXISTS vec_chunks");
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${dim}] distance_metric=cosine)`,
    );
    this.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('vec_dim', ?)")
      .run(String(dim));
    this.vecDim = dim;
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

  /** Delete all chunks AND symbols for a file (plus its ANN rows). */
  deleteFile(filePath: string): void {
    if (this.vecTableExists()) {
      const ids = this.db
        .prepare("SELECT id FROM chunks WHERE file_path = ?")
        .all(filePath) as Array<{ id: number }>;
      const del = this.db.prepare("DELETE FROM vec_chunks WHERE rowid = ?");
      for (const { id } of ids) del.run(BigInt(id));
    }
    this.db.prepare("DELETE FROM chunks WHERE file_path = ?").run(filePath);
    this.db.prepare("DELETE FROM symbols WHERE file_path = ?").run(filePath);
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
    if (this.vecEnabled && chunks.length > 0) {
      this.ensureVecTable(chunks[0]!.embedding.length);
    }
    const insert = this.db.prepare(
      `INSERT INTO chunks
         (file_path, chunk_text, start_line, end_line, file_mtime, embedding_provider, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const vecInsert = this.vecTableExists()
      ? this.db.prepare(
          "INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)",
        )
      : null;
    const insertMany = this.db.transaction((rows: typeof chunks) => {
      for (const row of rows) {
        const buf = Buffer.from(row.embedding.buffer);
        const info = insert.run(
          row.filePath,
          row.chunkText,
          row.startLine,
          row.endLine,
          row.fileMtime,
          row.embeddingProvider,
          buf,
        );
        // Mirror the embedding into the ANN index (rowid = chunk id).
        if (vecInsert && this.vecDim === row.embedding.length) {
          vecInsert.run(BigInt(info.lastInsertRowid), buf);
        }
      }
    });
    insertMany(chunks);
  }

  insertSymbols(
    symbols: Array<CodeSymbol & { filePath: string; fileMtime: number }>,
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO symbols (file_path, name, kind, line, signature, file_mtime)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertMany = this.db.transaction((rows: typeof symbols) => {
      for (const s of rows) {
        insert.run(
          s.filePath,
          s.name,
          s.kind,
          s.line,
          s.signature,
          s.fileMtime,
        );
      }
    });
    insertMany(symbols);
  }

  querySymbols(opts: {
    name?: string;
    kind?: string;
    pathFilter?: string;
    limit?: number;
  }): SymbolRow[] {
    const { name, kind, pathFilter, limit = 100 } = opts;

    let sql =
      "SELECT file_path, name, kind, line, signature FROM symbols WHERE 1=1";
    const params: (string | number)[] = [];

    if (name) {
      sql += " AND name LIKE ? COLLATE NOCASE";
      params.push(`%${name}%`);
    }
    if (kind) {
      sql += " AND kind = ?";
      params.push(kind);
    }
    if (pathFilter) {
      sql += " AND file_path LIKE ?";
      params.push(`%${pathFilter}%`);
    }

    sql += " ORDER BY file_path, line LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      file_path: string;
      name: string;
      kind: string;
      line: number;
      signature: string;
    }>;

    return rows.map((r) => ({
      filePath: r.file_path,
      name: r.name,
      kind: r.kind as SymbolKind,
      line: r.line,
      signature: r.signature,
    }));
  }

  getFileOutline(pathFilter: string): SymbolRow[] {
    const rows = this.db
      .prepare(
        `SELECT file_path, name, kind, line, signature
         FROM symbols
         WHERE file_path LIKE ?
         ORDER BY file_path, line`,
      )
      .all(`%${pathFilter}%`) as Array<{
      file_path: string;
      name: string;
      kind: string;
      line: number;
      signature: string;
    }>;

    return rows.map((r) => ({
      filePath: r.file_path,
      name: r.name,
      kind: r.kind as SymbolKind,
      line: r.line,
      signature: r.signature,
    }));
  }

  /** FTS search for a symbol name — used by code_references. */
  searchFtsForName(name: string, topK: number): SearchResult[] {
    // Wrap in quotes for exact phrase match, escape any internal quotes
    const escaped = name.replace(/"/g, '""');
    try {
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
        .all(`"${escaped}"`, topK) as Array<{
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
        score: -row.score,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Vector search entry point. Uses the sqlite-vec ANN index when it's built
   * and populated (sub-linear); otherwise falls back to the brute-force cosine
   * scan. Both use cosine distance, so scores are comparable across the two.
   */
  search(queryEmbedding: Float32Array, topK: number): SearchResult[] {
    if (this.vecTableExists()) {
      try {
        const rows = this.db
          .prepare(
            `SELECT c.id, c.file_path, c.chunk_text, c.start_line, c.end_line,
                    c.file_mtime, c.embedding_provider, v.distance
             FROM vec_chunks v
             JOIN chunks c ON c.id = v.rowid
             WHERE v.embedding MATCH ?
             ORDER BY v.distance
             LIMIT ?`,
          )
          .all(Buffer.from(queryEmbedding.buffer), topK) as Array<{
          id: number;
          file_path: string;
          chunk_text: string;
          start_line: number;
          end_line: number;
          file_mtime: number;
          embedding_provider: string;
          distance: number;
        }>;
        if (rows.length > 0) {
          return rows.map((row) => ({
            id: row.id,
            filePath: row.file_path,
            chunkText: row.chunk_text,
            startLine: row.start_line,
            endLine: row.end_line,
            fileMtime: row.file_mtime,
            embeddingProvider: row.embedding_provider,
            score: 1 - row.distance, // cosine distance → cosine similarity
          }));
        }
        // Table exists but empty (index predates ANN) → brute-force below.
      } catch {
        // ANN query failed for any reason → brute-force below.
      }
    }
    return this.searchBrute(queryEmbedding, topK);
  }

  /** Brute-force cosine similarity scan — fallback / <50k chunks. */
  searchBrute(queryEmbedding: Float32Array, topK: number): SearchResult[] {
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
      score: -row.score,
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

  symbolCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as n FROM symbols").get() as {
      n: number;
    };
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
