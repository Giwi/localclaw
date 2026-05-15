# localclaw

Autonomous AI agent powered by Ollama + OpenCode. Runs locally, creates its own tools, searches the web, executes code, and delegates complex tasks — all through a chat UI or REST API.

## Architecture

```
localclaw/
├── src/
│   ├── index.ts           # Express server entry point
│   ├── agent.ts           # Agent loop — Ollama function calling, tool execution, persistence
│   ├── api.ts             # REST API + SSE streaming for chat
│   ├── db.ts              # SQLite sessions & messages (better-sqlite3)
│   ├── log.ts             # Structured logger with levels (debug/info/warn/error)
│   ├── ollama.ts          # Ollama API client (streaming + non-streaming)
│   ├── opencode.ts        # OpenCode subprocess delegation
│   └── tools/
│       ├── types.ts        # Tool type definitions
│       ├── registry.ts     # Tool registry — builtins + dynamic create_tool
│       └── builtin/
│           ├── web-fetch.ts      # Web search (SearXNG / DuckDuckGo fallback) + URL fetch
│           ├── read-file.ts      # Local file reading
│           ├── write-file.ts     # Local file writing
│           ├── run-bash.ts       # Bash command execution
│           └── opencode-task.ts  # OpenCode delegation
├── client/                 # Angular 20 frontend
├── searxng/
│   └── settings.yml        # SearXNG config (JSON API + image proxy)
├── docker-compose.yml      # SearXNG service (port 8888)
├── Dockerfile              # Production build
└── .env                    # Configuration
```

## Quick Start

**Prerequisites:** Node.js 22+, Ollama with a model pulled (e.g. `qwen2.5:7b`), Docker (optional, for SearXNG).

```bash
# 1. Start SearXNG (optional — falls back to DuckDuckGo)
docker compose up -d

# 2. Install dependencies
npm install && cd client && npm install && cd ..

# 3. Configure OpenCode for Ollama
npm run setup:opencode

# 4. Start development server
npm run dev
```

Open http://localhost:4173

## Configuration

All settings via `.env`:

| Variable | Default | Description |
|---|---|---|
| `LOCALCLAW_PORT` | `4173` | Server port |
| `LOCALCLAW_DATA_DIR` | `~/.localclaw` | Data directory (sessions, tools, downloads) |
| `LOCALCLAW_OLLAMA_URL` | `http://localhost:11434` | Ollama API URL |
| `LOCALCLAW_MODEL` | `ollama/qwen2.5:7b` | Default model |
| `LOCALCLAW_SEARXNG_URL` | `http://localhost:8888` | SearXNG search URL (empty = DuckDuckGo fallback) |
| `LOCALCLAW_OPENCODE_BIN` | `opencode` | OpenCode binary path |
| `LOCALCLAW_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `LOCALCLAW_SANDBOX_ENABLED` | `false` | Wrap code execution in Docker containers |
| `LOCALCLAW_SANDBOX_IMAGE` | `ubuntu:22.04` | Docker image for sandboxed execution |
| `LOCALCLAW_EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model for RAG memory |

## How It Works

1. User sends a message via the Angular UI or REST API
2. The agent loop sends the conversation + available tools to Ollama
3. Ollama responds with either text or tool calls
4. Tool calls are executed (web search, file ops, bash, etc.)
5. Results are fed back to Ollama for the next reasoning step
6. The loop continues until the agent produces a final answer (up to 15 iterations)

### Built-in Tools

- **web_fetch** — Search the web (SearXNG → DuckDuckGo) or fetch a specific URL. Supports `text`, `images`, and `download` modes. Validates domain existence before fetching.
- **generate_image** — Generate images using Ollama image models (flux, sd, stable-diffusion). Saves to downloads directory.
- **read_file** / **write_file** — Read and write files on the local filesystem.
- **run_bash** — Execute any bash command (60s timeout, 10MB output buffer). Respects sandbox mode when enabled.
- **opencode_task** — Delegate complex multi-step coding tasks to OpenCode.
- **create_tool** — Dynamically create new reusable tools in JavaScript, Python, or Bash. Execution respects sandbox mode.

### RAG Memory

Tool results are automatically embedded (via Ollama embeddings API) and stored in SQLite. At the start of each conversation turn, the agent retrieves semantically relevant past tool results and injects them into the system prompt — enabling cross-session memory without filling the context window.

### Code Execution Sandbox

When `LOCALCLAW_SANDBOX_ENABLED=true`, `run_bash` and `create_tool` executions are wrapped in Docker containers with `--network none`, `--security-opt no-new-privileges`, and `--cap-drop ALL` for safe code execution.

### Image Generation

The `generate_image` tool calls Ollama's `/api/generate` with image models (flux, sd, etc.). Generated images are saved to the downloads directory and returned as URLs.

### Persistence & Resilience

The agent re-prompts itself when:
- A tool returns weak results (`No results`, `not found`, `Error:`, `< 30 chars`)
- The model gives up with phrases like `cannot find`, `does not contain`, `pas directement`
- The model responds with advisory text instead of using tools

### Web Search

Primary backend is SearXNG (Docker container on port 8888) with custom `settings.yml` that enables JSON API and image-focused engines (Pixabay, Flickr, DeviantArt, Getty, Openverse). Falls back to DuckDuckGo HTML search if SearXNG is not configured.

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/tools` | List registered tools |
| `GET` | `/api/sessions` | List sessions |
| `POST` | `/api/sessions` | Create session |
| `GET` | `/api/sessions/:id` | Get session |
| `DELETE` | `/api/sessions/:id` | Delete session |
| `PATCH` | `/api/sessions/:id` | Rename session |
| `GET` | `/api/sessions/:id/messages` | Get messages |
| `POST` | `/api/sessions/:id/chat` | Send message (SSE streaming response) |

### Chat Streaming

`POST /api/sessions/:id/chat` returns a Server-Sent Events stream with these event types:

```
data: {"type":"text","content":"thinking..."}
data: {"type":"tool_start","toolName":"web_fetch","toolArgs":{...}}
data: {"type":"tool_end","toolName":"web_fetch","toolResult":"..."}
data: {"type":"text","content":"final answer"}
data: {"type":"done"}
```

## Production Build

```bash
npm run build    # Builds both server (tsc) and client (ng build)
npm start        # Start production server
docker build -t localclaw .   # Or use Docker
```

## Frontend

Angular 20 single-page application with:
- Markdown rendering with syntax highlighting (highlight.js, atom-one-dark theme)
- 2 themes: Light and Dark
- Collapsible tool event cards showing real-time agent activity
- Dark mode auto-detection via `prefers-color-scheme`
- File downloads served via `/downloads` static route
