import { describe, it, expect } from "vitest";
import { search } from "../search.js";
import type { SearchResult } from "../db.js";

const sentinel: SearchResult[] = [
  {
    id: 1,
    filePath: "fts.ts",
    chunkText: "keyword hit",
    startLine: 1,
    endLine: 1,
    fileMtime: 0,
    embeddingProvider: "x",
    score: 1,
  },
];

describe("search() FTS fallback", () => {
  it("degrades to searchFts when the provider embed throws (provider died mid-session)", async () => {
    const db: any = {
      getProviderMeta: () => ({ name: "lm-studio", dim: 768 }),
      searchFts: () => sentinel,
      search: () => {
        throw new Error("vector path must not run after an embed failure");
      },
    };
    const provider: any = {
      name: "lm-studio",
      dim: 768,
      embed: async () => {
        throw new Error("provider down");
      },
    };

    const res = await search("some query", db, provider, {});
    expect(res).toBe(sentinel);
  });

  it("uses FTS directly when no index/meta exists yet", async () => {
    const db: any = {
      getProviderMeta: () => null,
      searchFts: () => sentinel,
      search: () => {
        throw new Error("vector path must not run without meta");
      },
    };
    const res = await search("q", db, null, {});
    expect(res).toBe(sentinel);
  });
});
