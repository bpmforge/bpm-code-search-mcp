# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/).

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
