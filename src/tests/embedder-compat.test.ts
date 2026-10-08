import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { CodeSearchDb } from "../db.js";
import { indexPath } from "../indexer.js";
import {
  checkCompat,
  detectProvider,
  ensureCompatibleIndex,
  matchesMeta,
  probeDimension,
} from "../embeddings/index.js";
import type { EmbeddingProvider } from "../embeddings/index.js";

function fake(name: string, model: string, dim: number): EmbeddingProvider {
  return {
    name,
    model,
    dim,
    async embed(texts: string[]) {
      return texts.map((t) => {
        const v = new Array(dim).fill(0);
        for (let i = 0; i < t.length; i++) v[i % dim] += t.charCodeAt(i) % 7;
        return v;
      });
    },
    async isAvailable() {
      return true;
    },
  };
}

describe("checkCompat", () => {
  const current = { name: "lm-studio", model: "nomic", dim: 768 };

  it("accepts an index with no recorded embedder", () => {
    expect(checkCompat(null, current, null)).toEqual({ ok: true });
  });

  it("accepts an identical embedder", () => {
    expect(checkCompat({ ...current }, current, 768)).toEqual({ ok: true });
  });

  it("refuses a model change on the same provider", () => {
    const r = checkCompat({ ...current, model: "bge-m3" }, current, 768);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('model "bge-m3" -> "nomic"');
  });

  it("refuses a dimension change", () => {
    const r = checkCompat({ ...current, dim: 1024 }, current, 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("dimension 1024 -> 768");
  });

  it("refuses a provider change", () => {
    const r = checkCompat({ ...current, name: "other" }, current, 768);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("provider");
  });

  it("does not refuse a legacy index for its missing model", () => {
    // Legacy records carry the hardcoded 768 whatever the model produced.
    const legacy = { name: "lm-studio", dim: 768 };
    expect(checkCompat(legacy, { ...current, dim: 1024 }, 1024)).toEqual({
      ok: true,
    });
    expect(checkCompat(legacy, { ...current, dim: 1024 }, null)).toEqual({
      ok: true,
    });
  });

  it("still refuses a legacy index whose stored vectors have another width", () => {
    const r = checkCompat({ name: "lm-studio", dim: 768 }, current, 1024);
    expect(r.ok).toBe(false);
  });
});

describe("matchesMeta", () => {
  it("requires name, model and dim to match a recorded index", () => {
    const p = fake("lm-studio", "nomic", 768);
    expect(matchesMeta(p, { name: "lm-studio", model: "nomic", dim: 768 })).toBe(true);
    expect(matchesMeta(p, { name: "lm-studio", model: "bge", dim: 768 })).toBe(false);
    expect(matchesMeta(p, { name: "lm-studio", model: "nomic", dim: 384 })).toBe(false);
  });

  it("matches a legacy index on provider name alone", () => {
    const p = fake("lm-studio", "nomic", 1024);
    expect(matchesMeta(p, { name: "lm-studio", dim: 768 })).toBe(true);
    expect(matchesMeta(p, { name: "other", dim: 768 })).toBe(false);
  });
});

describe("probeDimension / detectProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("measures the width of a real embedding", async () => {
    expect(await probeDimension(fake("x", "m", 5))).toBe(5);
  });

  it("records the configured model and the probed dimension, not 768", async () => {
    const bodies: Array<{ model: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (url.endsWith("/v1/models")) return new Response("{}", { status: 200 });
        bodies.push(JSON.parse(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({ data: [{ embedding: new Array(1024).fill(0.1) }] }),
          { status: 200 },
        );
      }),
    );
    const p = await detectProvider({
      lmStudioUrl: "http://lm.test",
      lmStudioModel: "text-embedding-bge-m3",
    });
    expect(p.model).toBe("text-embedding-bge-m3");
    expect(p.dim).toBe(1024);
    expect(bodies[0]?.model).toBe("text-embedding-bge-m3");
  });
});

describe("ensureCompatibleIndex with a real index", () => {
  let repo: string;
  let dbDir: string;
  let db: CodeSearchDb;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "compat-repo-"));
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "compat-db-"));
    db = new CodeSearchDb(path.join(dbDir, "index.db"));
    fs.writeFileSync(
      path.join(repo, "auth.ts"),
      "export function login(user: string): boolean {\n  return user.length > 0;\n}\n",
    );
  });

  afterEach(() => {
    db.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  async function build(p: EmbeddingProvider, force = false) {
    const gate = ensureCompatibleIndex(db, p, { force });
    if (gate.ok) await indexPath(repo, db, p, { force });
    return gate;
  }

  it("records the full embedder identity on first index", async () => {
    await build(fake("lm-studio", "nomic", 8));
    expect(db.getProviderMeta()).toEqual({ name: "lm-studio", model: "nomic", dim: 8 });
    expect(db.storedEmbeddingDim()).toBe(8);
  });

  it("refuses an incremental index after a model change, with the fix in the message", async () => {
    await build(fake("lm-studio", "nomic", 8));
    const gate = await build(fake("lm-studio", "bge", 8));
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.message).toContain("code_index(force=true)");
    expect(db.getProviderMeta()?.model).toBe("nomic");
  });

  it("force rebuilds cleanly across a provider and dimension change", async () => {
    await build(fake("lm-studio", "nomic", 8));
    fs.writeFileSync(
      path.join(repo, "gone.ts"),
      "export function removedLater(): number {\n  return 1234567890;\n}\n",
    );
    await indexPath(repo, db, fake("lm-studio", "nomic", 8));
    fs.rmSync(path.join(repo, "gone.ts"));

    const next = fake("other-provider", "bge", 16);
    const gate = await build(next, true);
    expect(gate).toEqual({ ok: true, cleared: true });
    expect(db.getProviderMeta()).toEqual({ name: "other-provider", model: "bge", dim: 16 });
    expect(db.storedEmbeddingDim()).toBe(16);
    // A file deleted since the old build must not linger with old vectors.
    expect(db.fileCount()).toBe(1);
    const [hit] = db.search(new Float32Array((await next.embed(["login"]))[0]!), 5);
    expect(hit?.embeddingProvider).toBe("other-provider");
    expect(ensureCompatibleIndex(db, next)).toEqual({ ok: true, cleared: false });
  });

  it("leaves a compatible legacy index alone without force, and upgrades it with force", async () => {
    await build(fake("lm-studio", "nomic", 8));
    db.setProviderMeta({ name: "lm-studio", dim: 768 }); // pre-model record

    const p = fake("lm-studio", "nomic", 8);
    expect(ensureCompatibleIndex(db, p)).toEqual({ ok: true, cleared: false });
    expect(db.getProviderMeta()).toEqual({ name: "lm-studio", dim: 768 });

    const gate = await build(p, true);
    expect(gate).toEqual({ ok: true, cleared: true });
    expect(db.getProviderMeta()).toEqual({ name: "lm-studio", model: "nomic", dim: 8 });
    expect(db.fileCount()).toBe(1);
  });
});
