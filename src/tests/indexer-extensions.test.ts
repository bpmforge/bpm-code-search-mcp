import { describe, it, expect } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { CodeSearchDb } from "../db.js";
import { indexPath } from "../indexer.js";
import type { EmbeddingProvider } from "../embeddings/index.js";

const fakeProvider: EmbeddingProvider = {
  name: "fake",
  dim: 4,
  async embed(texts: string[]) {
    return texts.map(() => [1, 0, 0, 0]);
  },
  async isAvailable() {
    return true;
  },
};

describe("indexPath default file types", () => {
  // The chunker and symbol extractor already understand these extensions;
  // this guards against the indexer's glob list drifting from them again.
  // Bodies are long enough to clear the fallback chunker's minimum size.
  const cpp = "int answer() {\n  return computeTheAnswerToEverything(6, 7);\n}\n";
  it.each([
    ["widget.cc", cpp],
    ["widget.cxx", cpp],
    ["widget.hpp", cpp],
    [
      "build.gradle.kts",
      'plugins {\n  kotlin("jvm") version "2.0.0"\n}\n\ndependencies {\n  implementation(kotlin("stdlib"))\n}\n',
    ],
  ])(
    "indexes %s",
    async (name, body) => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ext-repo-"));
      const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-db-"));
      const db = new CodeSearchDb(path.join(dbDir, "index.db"));
      try {
        fs.writeFileSync(path.join(repo, name), body);
        const result = await indexPath(repo, db, fakeProvider);
        expect(result.errors).toEqual([]);
        expect(result.indexed).toBe(1);
        expect(db.fileCount()).toBe(1);
      } finally {
        db.close();
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(dbDir, { recursive: true, force: true });
      }
    },
  );
});
