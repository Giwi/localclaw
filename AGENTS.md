# localclaw — agent instructions

## Commands

```bash
npm run dev          # dev server (tsx --env-file=.env)
npx tsc --noEmit     # typecheck only
npm run build:server # tsc → dist/
```

No test runner configured on the server side. Angular client has `ng test` via Karma/Jasmine.

## Architecture

- **ESM** (`"type": "module"`). All imports use `.js` extensions even for `.ts` sources.
- **Express** server + **Angular 20** SPA client. Server entry: `src/index.ts`.
- **SQLite** (`better-sqlite3`, synchronous API, WAL mode). Schema auto-created on startup in `src/db.ts`.
- **Ollama** integration via raw `fetch()` calls (no SDK). Chat: `POST /api/chat`, embeddings: `POST /api/embed` (not the old `/api/embeddings`).
- **Tool interface** (`src/tools/types.ts`): `ToolModule = { definition, execute(args, onChunk?) }`. The `onChunk` callback is used for real-time output streaming.
- **Agent loop** (`src/agent.ts`): up to 15 tool-calling iterations per turn. Ollama response includes `tool_calls` with function name + JSON args.
- **Tool streaming**: Agent races `Promise.race([toolPromise, setTimeout(150)])` to flush `tool_chunk` events every 150ms during execution.
- **SSE streaming**: Chat responses stream via Server-Sent Events (`POST /api/sessions/:id/chat`). Events: `tool_start`, `tool_chunk`, `tool_end`, `tool_error`, `text`, `done`.

## Registering tools

Most builtins are registered statically in `src/tools/registry.ts:registerBuiltins()`. Tools needing DB access (`schedule_task`, `search_knowledge`) are registered via `registry.register()` in `src/index.ts` — these use factory functions that receive the `Database` instance.

To add a new tool:
1. Create `src/tools/builtin/<name>.ts` exporting a `ToolModule`
2. If it needs DB access, use a factory `createXTool(db): ToolModule` and register in `index.ts`
3. Otherwise add to the builtins array in `registry.ts`
4. Add to the `SYSTEM_PROMPT` in `agent.ts` so the LLM knows about it

## Key behaviors an agent might miss

- **`_sessionId`** is injected into tool args by `agent.ts` (line ~274) for tools that need session context.
- **Context summarization**: triggers automatically when message history exceeds ~8000 chars. Old messages are summarized via Ollama, keeping the last 2 exchanges.
- **RAG memory**: tool results are auto-embedded and stored per-session (`memory_entries`). Every chat turn also searches global **knowledge base** (`knowledge_chunks` from uploaded documents).
- **Agent re-prompting**: The agent re-prompts itself if a tool result is weak (`< 30 chars`, `"No results"`, `"Error:"`), if the model gives up (`"cannot find"`), or if it gives advisory text without calling a tool.
- **Browser automation** (`browser_automation` tool): uses system Chromium at `/snap/bin/chromium` in headless mode. Not Playwright — no browser binary download needed.
- **Sandbox mode**: When `LOCALCLAW_SANDBOX_ENABLED=true`, `run_bash` and dynamic tools execute inside Docker with `--network none --cap-drop ALL`.
- **Background scheduler** (`src/scheduler.ts`): polls every 30s for due tasks. Schedule formats: `every Xm`, `every Xh`, `daily at HH:MM`, `daily`, `weekly`.
- **Embedding model**: defaults to `nomic-embed-text`. Must be pulled in Ollama separately from the chat model.
- **`.env` is gitignored**. Secrets (API keys, tokens) go there.

## External dependencies

| Service | Config var | Required? |
|---|---|---|
| Ollama | `LOCALCLAW_OLLAMA_URL` | yes |
| SearXNG (Docker) | `LOCALCLAW_SEARXNG_URL` | optional (falls back to DuckDuckGo) |
| Mailgun | `LOCALCLAW_MAILGUN_API_KEY` + `_DOMAIN` + `_FROM` | optional |
| Telegram | `LOCALCLAW_TELEGRAM_BOT_TOKEN` | optional |
