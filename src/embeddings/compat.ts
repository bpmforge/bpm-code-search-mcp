import type { CodeSearchDb } from "../db.js";
import type { EmbeddingProvider, ProviderMeta } from "./types.js";

export type Compat = { ok: true } | { ok: false; reason: string };

export function metaFor(provider: EmbeddingProvider): ProviderMeta {
  return { name: provider.name, model: provider.model, dim: provider.dim };
}

/**
 * Decide whether `current` can keep using an index built under `stored`.
 *
 * A legacy record (no `model`) is treated as "model unknown" and never
 * refused on that basis. Its recorded dim was hardcoded, so the width of the
 * vectors actually in the index (`storedVectorDim`) stands in for it: a
 * real width mismatch still makes every cosine score meaningless.
 */
export function checkCompat(
  stored: ProviderMeta | null,
  current: ProviderMeta,
  storedVectorDim: number | null,
): Compat {
  if (!stored) return { ok: true };
  const diffs: string[] = [];
  if (stored.name !== current.name) {
    diffs.push(`provider "${stored.name}" -> "${current.name}"`);
  }
  if (stored.model !== undefined && stored.model !== current.model) {
    diffs.push(`model "${stored.model}" -> "${current.model}"`);
  }
  const indexedDim = stored.model !== undefined ? stored.dim : storedVectorDim;
  if (indexedDim !== null && indexedDim !== current.dim) {
    diffs.push(`dimension ${indexedDim} -> ${current.dim}`);
  }
  return diffs.length === 0 ? { ok: true } : { ok: false, reason: diffs.join(", ") };
}

/** True when `provider` can embed queries for an index recorded as `meta`. */
export function matchesMeta(
  provider: EmbeddingProvider,
  meta: ProviderMeta,
): boolean {
  if (provider.name !== meta.name) return false;
  if (meta.model === undefined) return true; // legacy: model and dim unknown
  return provider.model === meta.model && provider.dim === meta.dim;
}

export function mismatchMessage(reason: string): string {
  return (
    `The embedding model changed since this index was built (${reason}). ` +
    "Vectors from different models are not comparable, so the index cannot be used or updated as-is. " +
    "Run code_index(force=true) to rebuild it with the current model."
  );
}

/**
 * Gate an indexing run on the stored embedder identity. Without `force`, a
 * mismatch is refused. With `force`, a mismatched or legacy index is wiped
 * first so no vector from the old model survives the rebuild.
 */
export function ensureCompatibleIndex(
  db: CodeSearchDb,
  provider: EmbeddingProvider,
  options: { force?: boolean } = {},
): { ok: true; cleared: boolean } | { ok: false; message: string } {
  const current = metaFor(provider);
  const stored = db.getProviderMeta();
  const check = checkCompat(stored, current, db.storedEmbeddingDim());
  if (!check.ok && !options.force) {
    return { ok: false, message: mismatchMessage(check.reason) };
  }
  let cleared = false;
  if (options.force && stored && (!check.ok || stored.model === undefined)) {
    db.clearIndex();
    cleared = true;
  }
  // A compatible legacy record is left as-is without force: writing the
  // current model into it would claim knowledge of how it was built.
  if (!stored || options.force) db.setProviderMeta(current);
  return { ok: true, cleared };
}
