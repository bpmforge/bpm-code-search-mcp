# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Work merged to `main` after v0.4.0 (2026-07-16 → 2026-09-28). `package.json`
still says 0.4.0.

### Added

- **Symbol graph tables** (`defs`, `refs`, `calls`, `imports`) populated at
  index time — tree-sitter extraction with a regex fallback for grammarless
  languages. `refs` is a global cross-file xref.
- **Retrieval pipeline library** (`src/search/query.ts`): ontology expansion →
  BM25F + vector kNN + exact-identifier match → RRF → rank adjustment →
  1-hop caller/callee clustering, plus evidence packets (`src/packet/`). Not
  yet exposed as an MCP tool.
- **Concept ontology** (`ontology/concepts.yaml`, `src/ontology/`) with
  `expand()`; 42 concepts covering OWASP Top-10 (web 2021, LLM 2025) and the
  CWE Top-25 (2024).
- **Golden retrieval eval** (`eval/`): 16 judgments over a 12-file fixture
  repo with Recall@k / MRR metrics and a regression floor
  (measured Recall@5 = 0.906, MRR = 0.437).
- `docs/LODESTONE_DESIGN.md` design document.
- `.node-version` pins Node 24.

### Changed

- **cAST tree-sitter chunker** replaces the 60-line window: chunks at
  function/method/class granularity (split-then-merge, ~1200-token budget)
  for TS/TSX/JS, Python, Go, Rust, Java, C#, Ruby, PHP, C and C++. The
  sliding window remains the fallback for other files and parse failures.
- **BM25F keyword ranking**: the FTS5 table now has weighted `symbols`,
  `subtokens` (camelCase/snake_case splits) and `body` columns. Existing
  indexes are migrated in place and backfilled on open.

### Fixed

- `code_index(force=true)` now actually re-indexes unchanged files. It
  previously reopened the same database file, so the mtime gate still skipped
  every unchanged file.
- The MCP server reported version `0.2.0`; it now reports `0.4.0`.
- The index now records the embedding model name and the dimension measured
  from a real embedding, not just the provider name and a hardcoded 768. A
  provider, model or dimension change makes `code_search` and `code_index`
  refuse with a pointer to `code_index(force=true)`, which clears the old
  index and rebuilds it (previously a provider change left `code_index`
  reporting "no provider" even with `force=true`). Older indexes without a
  recorded model are treated as "model unknown" and not refused for it.
- `.cc`, `.cxx`, `.hpp` and `.kts` files are now indexed; the chunker and
  symbol extractor already handled them but the indexer never picked them up.

### Tests

- 172 tests green.

## [0.4.0] — 2026-07-14

Tier C — ANN vector index (staged code-search enhancement plan, 3 of 3).

### Added

- **sqlite-vec ANN index for vector search.** The brute-force cosine scan loaded
  *every* chunk embedding and scored it per query (the code literally noted "fine
  for <50k chunks"). Vector search now goes through a `vec0` cosine index
  (sub-linear KNN), mirrored from the chunk embeddings at index time and kept in
  sync on re-index and file delete. Cosine distance matches the brute-force
  scores, so results are identical in ranking — just faster on large repos.
- **Guaranteed brute-force fallback.** If the sqlite-vec extension can't load
  (platform/ABI) or the ANN table isn't populated yet (an index built by an
  earlier version), `search()` transparently falls back to the brute-force cosine
  scan. ANN is a pure speedup, never a correctness dependency. Run
  `code_index --force` once to build the ANN index for a pre-0.4 index.

### Fixed

- **The ANN provider flag could never turn on.** The constructor read the
  `meta` table for the stored vec dimension *before* creating the schema, so the
  read threw and silently disabled the vector extension for the whole process.
  Reordered so the index actually activates. (Caught by the new ANN tests.)

### Tests

- `ann.test.ts`: extension loads, nearest-first ranking with cosine scores, ANN
  rows dropped on file delete, and ANN ranking agrees with the brute-force scan.
  55 tests green.

## [0.3.0] — 2026-07-14

Tier B — hybrid search (staged code-search enhancement plan, 2 of 3).

### Changed

- **`code_search` is now hybrid: semantic (vector) + keyword (BM25) fused with
  Reciprocal Rank Fusion.** Before, it was vector-only (or FTS-only as a cold
  fallback) — so an exact identifier the paraphrased query embedding missed
  wouldn't surface. RRF (k=60) needs no cross-engine score normalization (cosine
  vs BM25), so both rankings contribute cleanly; a chunk that ranks in both lists
  floats to the top. Degrades exactly as before: no embedder/index →
  keyword-only, empty keyword hits → vector-only.
- **Natural-language queries can no longer break FTS.** The keyword side now
  runs through an FTS5-safe sanitizer (word tokens quoted + OR-ed), so a query
  like `how does auth work?` no longer risks throwing on FTS operator characters.

### Tests

- `toFtsQuery`, `rrfFuse` (both-lists-rank-higher, de-dup), and a both-sides
  fusion path. 51 tests green.

## [0.2.0] — 2026-07-14

Tier A — response quality & robustness (staged code-search enhancement plan, 1 of 3).

### Changed

- **`code_references` returns the actual referencing lines, not whole chunks.**
  It previously dumped the full 60-line chunk for every hit (a wall of code —
  tens of KB for a common symbol). Now it extracts only the lines that mention
  the symbol (word-boundary match), each as `file:line` with ±2 lines of context
  and a **`[def]`/`[use]` tag** (definition lines are cross-referenced against the
  symbol index). Overlapping-chunk duplicates are collapsed. Far tighter, far
  more useful, and it's now a real def/use view rather than an FTS chunk dump.
- **`code_search` snippets are capped** (default 24 lines) with an elision note,
  so a single huge chunk can't flood the response — the `file:line` header points
  at the full source.

### Fixed

- **`code_search` degrades to keyword search instead of erroring when the query
  embedding fails.** If the embedding provider dies mid-session (e.g. LM Studio
  stopped after startup), search now falls back to FTS rather than returning an
  error — recall must not hard-fail because the embedder went away.

### Tests

- `format.test.ts` (line extraction, def/use tagging, word-boundary, de-dup,
  truncation, snippet capping) and `search-fallback.test.ts` (FTS fallback on
  embed failure / no index). 46 tests green.

## [0.1.0] — 2026-06-02

Initial release. The git tag `v1.0.0` points at this release (commit
`94f48f5`), whose `package.json` says 0.1.0.

### Added

- MCP tools `code_search` (semantic search, cosine similarity), `code_index`
  (mtime-gated indexing) and `code_index_status`.
- Symbol index layer with MCP tools `code_symbols`, `code_outline` and
  `code_references`: regex extraction for TS/JS, Python, Go, Rust, Java, C#,
  Ruby, PHP, Swift, Kotlin and Markdown headings.
- LM Studio embedding provider (`nomic-embed-text-v1.5`), provider identity
  recorded in the index; FTS5 keyword fallback.
- 60-line sliding-window chunker (15-line overlap); SQLite (WAL) index at
  `.code-search/index.db`.
- Configuration via `CODE_SEARCH_ROOT`, `LM_STUDIO_URL`, `LM_STUDIO_MODEL`.
- README.

### Tests

- 36 tests green.
