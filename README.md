# bpm-code-search-mcp

Semantic code search + structural symbol index for any codebase. An MCP server that lets AI agents search code by meaning, browse what exists (functions, classes, types), and trace references — without loading entire files into context.

Works with **Claude Code**, **OpenCode**, or any MCP client. Auto-installed by `claude-experts` and `bpm-opencode-experts`.

## What it does

| Tool | Use it for |
|------|-----------|
| `code_index` | Build or refresh the search index (mtime-gated, skips unchanged files) |
| `code_search` | Semantic search — "authentication middleware", "cosine similarity" |
| `code_symbols` | Browse by kind — all classes, functions named `*Auth*`, interfaces in `src/` |
| `code_outline` | Structural outline of a file — all named symbols in line order |
| `code_references` | Find everywhere a symbol is mentioned |
| `code_index_status` | Provider, file count, chunk count, symbol count |

## How it works

- **Semantic search** — embeds code chunks (60-line sliding window) via LM Studio (`nomic-embed-text`), stores in SQLite, scores with cosine similarity
- **Symbol index** — regex extraction at index time; no AST required; covers 10 languages
- **FTS5 fallback** — BM25 keyword search when no embedding provider is available
- **Provider sticky** — the embedding model used at index time is locked in; queries from a different provider fall back to FTS5 rather than silently mixing vector spaces

## Symbol extraction covers

TypeScript/JS · Python · Go · Rust · Java · C# · Ruby · PHP · Swift · Kotlin · Markdown headings

## Install

Handled automatically by `claude-experts` or `bpm-opencode-experts` `install.sh`.

**Manual:**
```bash
git clone https://github.com/bpmforge/bpm-code-search-mcp.git ~/Code/bpm-code-search-mcp
cd ~/Code/bpm-code-search-mcp && npm install && npm run build

# Claude Code
claude mcp add code-search node ~/Code/bpm-code-search-mcp/dist/index.js

# OpenCode — add to opencode.json under "mcp":
# "code-search": { "type": "local", "command": ["node", "~/Code/bpm-code-search-mcp/dist/index.js"], "enabled": true }
```

## First use

```
code_index()          # index the current project (run once, then auto-updates on file edits)
code_index_status()   # verify: provider, files, chunks, symbols
code_search("authentication flow")
code_symbols(kind="class")
code_outline("src/auth.ts")
code_references("UserService")
```

## Requirements

- Node 20–24 LTS

## Embedding setup

Vector search is optional — **BM25 keyword search works with no setup at all**.

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

### OpenAI embeddings
```bash
export LM_STUDIO_URL="https://api.openai.com/v1"
export LM_STUDIO_MODEL="text-embedding-3-small"
export OPENAI_API_KEY="sk-..."
```

### No embeddings (BM25 only)
```bash
export EMBEDDING_PROVIDER=none
```

> **Provider-sticky:** The embedding model used at index time is locked in. If you change models, re-index with `code_index(force=true)` to rebuild from scratch.

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
| `EMBEDDING_PROVIDER` | _(auto-detect)_ | Set to `none` to disable vectors |

## License

MIT
