# bpm-code-search-mcp

Semantic code search + structural symbol index for any codebase. An MCP server that lets AI agents search code by meaning, browse what exists (functions, classes, types), and trace references — without loading entire files into context.

Works with **Claude Code**, **OpenCode**, or any MCP client. Auto-installed by [`attest-claude`](https://github.com/bpmforge/attest-claude) (Claude Code) and [`attest`](https://github.com/bpmforge/attest) (OpenCode).

## What it does

| Tool | Use it for |
|------|-----------|
| `code_index` | Build or refresh the search index (mtime-gated, skips unchanged files) |
| `code_search` | Semantic search — "authentication middleware", "cosine similarity" |
| `code_symbols` | Browse by kind — all classes, functions named `*Auth*`, interfaces in `src/` |
| `code_outline` | Structural outline of a file — all named symbols in line order |
| `code_references` | Find everywhere a symbol is mentioned — `file:line` with context, tagged `[def]`/`[use]` |
| `code_index_status` | Provider, file count, chunk count, symbol count |

## How it works

- **AST chunking** — files are split at function/method/class boundaries with tree-sitter (cAST split-then-merge, ~1200-token budget) for TS/TSX/JS, Python, Go, Rust, Java, C#, Ruby, PHP, C and C++; other files (and any parse failure) fall back to a 60-line sliding window with 15-line overlap
- **Hybrid search** — `code_search` fuses semantic (vector) and keyword (BM25F over symbol names, identifier subtokens and body) rankings with Reciprocal Rank Fusion (k=60), so it finds both meaning and exact identifiers
- **Vector index** — chunks are embedded via LM Studio (`nomic-embed-text` by default) and stored in SQLite; queries use a `sqlite-vec` ANN index, falling back to a brute-force cosine scan if the extension can't load
- **Keyword fallback** — if the embedding provider is unavailable at query time, search degrades to keyword-only instead of erroring
- **Symbol index** — regex extraction at index time covering 10 languages plus Markdown headings, alongside a symbol graph (defs/refs/calls/imports)
- **Provider sticky** — the provider name and vector dimension used at index time are recorded; a mismatched provider disables vector search rather than silently mixing vector spaces

## Symbol extraction covers

TypeScript/JS · Python · Go · Rust · Java · C# · Ruby · PHP · Swift · Kotlin · Markdown headings

Files indexed by default: `.ts .tsx .js .jsx .mjs .cjs .py .rs .go .java .cs .cpp .c .h .rb .php .swift .kt .md .mdx` (skipping `node_modules`, `dist`, `build`, `.git`, `coverage`, `*.min.js`, `*.map`). The index lives at `.code-search/index.db` under the project root.

## Install

Handled automatically by the `install.sh` of [`attest-claude`](https://github.com/bpmforge/attest-claude) or [`attest`](https://github.com/bpmforge/attest).

**Manual:**
```bash
git clone https://github.com/bpmforge/bpm-code-search-mcp.git ~/Code/bpm-code-search-mcp
cd ~/Code/bpm-code-search-mcp && npm ci && npm run build

# Claude Code
claude mcp add code-search node ~/Code/bpm-code-search-mcp/dist/index.js

# OpenCode — add to opencode.json under "mcp":
# "code-search": { "type": "local", "command": ["node", "~/Code/bpm-code-search-mcp/dist/index.js"], "enabled": true }
```

## First use

```
code_index()          # index the current project; re-run after changes (unchanged files are skipped by mtime)
code_index_status()   # verify: provider, files, chunks, symbols
code_search("authentication flow")
code_symbols(kind="class")
code_outline("src/auth.ts")
code_references("UserService")
```

## Requirements

- Node 20–24 LTS (`.node-version` pins 24)
- An embedding endpoint (LM Studio by default) to build the index — see below

## Embedding setup

`code_index` needs a reachable embedding endpoint: it embeds every chunk and refuses to run without one. Once an index exists, `code_search` keeps working (keyword-only) if the embedder later goes away, and `code_symbols` / `code_outline` / `code_references` never need it.

### Default: LM Studio (free, local)
1. Download [LM Studio](https://lmstudio.ai) and load `nomic-ai/nomic-embed-text-v1.5-GGUF`
2. No config needed — defaults point to `http://localhost:1234`

### Alternative models
Set env vars to use a different model:
```bash
export LM_STUDIO_URL="http://localhost:1234"
export LM_STUDIO_MODEL="CompendiumLabs/bge-large-en-v1.5-gguf"  # example
```

| Model | Dimensions | Notes |
|-------|-----------|-------|
| `nomic-ai/nomic-embed-text-v1.5` | 768 | Default — good balance |
| `CompendiumLabs/bge-large-en-v1.5-gguf` | 1024 | Better quality, slower |
| `CompendiumLabs/bge-small-en-v1.5-gguf` | 384 | Fastest, smaller |

### Other OpenAI-compatible servers
Any server exposing `GET /v1/models` and `POST /v1/embeddings` works. `LM_STUDIO_URL` is the server root — the client appends `/v1/...` itself, so do not include `/v1`. No `Authorization` header is sent, so hosted APIs that require an API key are not supported.

> **Provider-sticky:** Only the provider name and vector dimension are recorded at index time, not the model name. If you change models, re-index with `code_index(force=true)` so every file is re-embedded with the new model.

### Remote LM Studio server
```bash
export LM_STUDIO_URL="http://192.168.1.x:1234"
```

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CODE_SEARCH_ROOT` | `cwd` | Project root to index |
| `LM_STUDIO_URL` | `http://localhost:1234` | Embedding API base URL |
| `LM_STUDIO_MODEL` | `text-embedding-nomic-embed-text-v1.5` | Embedding model name |

## License

MIT
