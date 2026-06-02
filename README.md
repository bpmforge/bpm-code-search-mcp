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

- Node 20+
- LM Studio running `text-embedding-nomic-embed-text-v1.5` on port 1234 for vector search
- BM25 keyword search works without LM Studio

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CODE_SEARCH_ROOT` | `cwd` | Project root to index |
| `LM_STUDIO_URL` | `http://localhost:1234` | LM Studio base URL |
| `LM_STUDIO_MODEL` | `text-embedding-nomic-embed-text-v1.5` | Embedding model |

## License

MIT
