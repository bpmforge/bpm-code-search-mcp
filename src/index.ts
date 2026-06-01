#!/usr/bin/env node
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CodeSearchDb } from "./db.js";
import { detectProvider } from "./embeddings/index.js";
import type { EmbeddingProvider } from "./embeddings/index.js";
import { indexPath } from "./indexer.js";
import { search } from "./search.js";

const ROOT = process.env.CODE_SEARCH_ROOT ?? process.cwd();
const DB_PATH = path.join(ROOT, ".code-search", "index.db");
const LM_STUDIO_URL = process.env.LM_STUDIO_URL ?? "http://localhost:1234";
const LM_STUDIO_MODEL =
  process.env.LM_STUDIO_MODEL ?? "text-embedding-nomic-embed-text-v1.5";

const db = new CodeSearchDb(DB_PATH);
let provider: EmbeddingProvider | null = null;

async function getProvider(): Promise<EmbeddingProvider | null> {
  if (provider) return provider;
  try {
    provider = await detectProvider({
      lmStudioUrl: LM_STUDIO_URL,
      lmStudioModel: LM_STUDIO_MODEL,
    });
    const meta = db.getProviderMeta();
    if (!meta) {
      db.setProviderMeta({ name: provider.name, dim: provider.dim });
    } else if (meta.name !== provider.name || meta.dim !== provider.dim) {
      // Provider changed since last index — require re-index
      provider = null;
      return null;
    }
  } catch {
    provider = null;
  }
  return provider;
}

const server = new McpServer({ name: "bpm-code-search-mcp", version: "0.1.0" });

server.tool(
  "code_search",
  "Search the codebase by meaning, not just keywords. Returns the most relevant code chunks with file paths and line numbers.",
  {
    query: z
      .string()
      .describe(
        'Natural language or code query (e.g. "HANDOFF confidence scoring", "auth middleware", "cosine similarity")',
      ),
    top_k: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(10)
      .describe("Number of results to return (default 10)"),
    path_filter: z
      .string()
      .optional()
      .describe(
        'Only return results whose file path contains this string (e.g. "src/auth", ".md")',
      ),
  },
  async ({ query, top_k, path_filter }) => {
    try {
      const p = await getProvider();
      if (db.chunkCount() === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Index is empty. Run code_index first to index the codebase.",
            },
          ],
        };
      }

      const results = await search(query, db, p, {
        topK: top_k,
        pathFilter: path_filter,
      });

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No results found." }],
        };
      }

      const formatted = results
        .map(
          (r, i) =>
            `[${i + 1}] ${r.filePath}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)})\n\`\`\`\n${r.chunkText}\n\`\`\``,
        )
        .join("\n\n");

      return { content: [{ type: "text" as const, text: formatted }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Search error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "code_index",
  "Index or re-index the codebase for semantic search. Run once after cloning a repo, then again when many files change. Skips files unchanged since last index.",
  {
    path: z
      .string()
      .optional()
      .describe(
        "Subdirectory to index (relative to project root). Omit to index the entire project.",
      ),
    force: z
      .boolean()
      .optional()
      .default(false)
      .describe("Force re-index all files, ignoring mtime cache"),
  },
  async ({ path: subPath, force }) => {
    try {
      const p = await getProvider();
      if (!p) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No embedding provider available. Start LM Studio with a text embedding model loaded (default: text-embedding-nomic-embed-text-v1.5 on localhost:1234) then retry.",
            },
          ],
          isError: true,
        };
      }

      const targetPath = subPath ? path.resolve(ROOT, subPath) : ROOT;

      if (force) {
        // Wipe index for re-index
        db.close();
        const freshDb = new CodeSearchDb(DB_PATH);
        Object.assign(db, freshDb);
        db.setProviderMeta({ name: p.name, dim: p.dim });
      }

      const result = await indexPath(targetPath, db, p);
      const summary = [
        `Indexed ${result.indexed} file(s), skipped ${result.skipped} unchanged.`,
        `Total: ${db.fileCount()} files, ${db.chunkCount()} chunks in index.`,
        result.errors.length > 0
          ? `Errors (${result.errors.length}):\n${result.errors.slice(0, 5).join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      return { content: [{ type: "text" as const, text: summary }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Index error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "code_index_status",
  "Check the current state of the code search index.",
  {},
  async () => {
    const meta = db.getProviderMeta();
    const chunks = db.chunkCount();
    const files = db.fileCount();
    const status = meta
      ? `Provider: ${meta.name} (dim=${meta.dim})\nFiles: ${files}\nChunks: ${chunks}\nIndex: ${DB_PATH}`
      : `No index yet. Run code_index to build it.\nIndex location: ${DB_PATH}`;
    return { content: [{ type: "text" as const, text: status }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
