import { CodeSearchDb, type SearchResult } from "./db.js";
import type { EmbeddingProvider } from "./embeddings/index.js";
import { providerFromMeta } from "./embeddings/index.js";

export interface SearchOptions {
  topK?: number;
  pathFilter?: string;
}

export async function search(
  query: string,
  db: CodeSearchDb,
  activeProvider: EmbeddingProvider | null,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const topK = options.topK ?? 10;

  const meta = db.getProviderMeta();

  // If no index exists yet, fall back to FTS5
  if (!meta) {
    return db.searchFts(query, topK);
  }

  // Ensure the query is embedded with the same provider that built the index.
  // If the active provider doesn't match, try to reconstruct it from meta.
  let provider = activeProvider;
  if (!provider || provider.name !== meta.name || provider.dim !== meta.dim) {
    try {
      provider = providerFromMeta(meta);
    } catch {
      // Provider unavailable — fall back to FTS5 rather than mix vector spaces
      return db.searchFts(query, topK);
    }
  }

  const [[queryEmbedding]] = [await provider.embed([query])];
  const vec = new Float32Array(queryEmbedding);
  let results = db.search(vec, topK * 2); // over-fetch before path filter

  if (options.pathFilter) {
    const filter = options.pathFilter.toLowerCase();
    results = results.filter((r) => r.filePath.toLowerCase().includes(filter));
  }

  return results.slice(0, topK);
}
