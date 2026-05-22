# Architecture

How localclaw works under the hood — from message submission to final response.

## High-level flow

```
User message
  │
  ├─► WebSocket handler (ws.ts)
  │     ├─ Store user message in SQLite
  │     ├─ Auto-rename "New Session" on first message
  │     └─ Run agent loop
  │
  ├─► Agent loop (agent.ts) — up to 15 iterations
  │     │
  │     ├─ 1. RAG injection
  │     │     ├─ Embed last user message
  │     │     ├─ Retrieve relevant memories (past tool results)
  │     │     └─ Retrieve knowledge chunks (uploaded documents)
  │     │
  │     ├─ 2. Context summarization
  │     │     └─ If history > ~8000 chars, summarize older messages via Ollama
  │     │
  │     ├─ 3. Pre-planning (first message only)
  │     │     ├─ Classify query complexity (Ollama, fast)
  │     │     ├─ If SIMPLE → skip to agent loop
  │     │     └─ If COMPLEX → OpenCode answers directly (2 rounds, 3 parallel prompts)
  │     │
  │     ├─ 4. Ollama chat call
  │     │     └─ Send system prompt + history + tool list → receive text or tool_calls
  │     │
  │     ├─ 5. Tool execution (if tool_calls present)
  │     │     ├─ Execute tool → stream chunks → yield tool_end
  │     │     ├─ Append tool + result to conversation
  │     │     └─ Store tool result as memory embedding
  │     │
  │     ├─ 6. Failure handling (if text without tool call)
  │     │     ├─ Priority 0: fabricated content → create dynamic tool via OpenCode
  │     │     ├─ Priority 1: weak result + advisory/giving up → create dynamic tool
  │     │     ├─ Priority 2: advisory text → re-prompt with force-tool
  │     │     ├─ Priority 3: weak tool result → re-prompt with PERSIST_MSG
  │     │     └─ Priority 4: giving-up text → re-prompt with PERSIST_MSG
  │     │
  │     └─ 7. Loop or yield
  │           └─ If text passed all checks → yield as final answer
  │
  └─► Response stored
        ├─ Assistant message + tool_results JSON → SQLite
        ├─ Memory entries → embeddings → SQLite
        └─ Session updated with new timestamp
```

## Agent loop (`src/agent.ts`)

The core of the system. An async generator (`async *run()`) that yields `AgentEvent` objects to the WebSocket handler.

### System prompt

The system prompt is built from three parts:

- **HEAD** (~130 lines): agent identity, approach, execution strategies, verification rules
- **Tool list**: auto-generated from `ToolRegistry.list()` — `<tool>(<params>) — <description>` per tool
- **TAIL** (~25 lines): initiative, autonomy, creativity, language matching

The full prompt (~180 lines) defines the agent's personality, rules, and tool set.

### Tool execution

When Ollama responds with `tool_calls`, the agent loop:

1. Validates the tool name and parses JSON arguments
2. Drops any `_sessionId` argument (injected automatically)
3. Executes the tool with a race condition: the tool runs in parallel with a 150ms polling interval
4. Each poll flushes any `onChunk` callbacks as `tool_chunk` events
5. On completion, yields `tool_end` with the result and optional widget
6. Appends the tool call + result to the conversation (assistant + tool messages)
7. Stores the result as a memory embedding for future RAG retrieval
8. Unregisters dynamic tools that returned 0 characters

### Pre-planning

For the first user message in a conversation (no assistant history yet):

1. **Query complexity classification** — fast Ollama call (`num_predict: 10, temperature: 0`) asks: SIMPLE or COMPLEX? Simple queries (greetings, small talk) skip all pre-planning.
2. **Tool domain check** — regex patterns match tool-related queries (weather, news, TV guide) and action requests (schedule, send, write). These skip pre-plan and go to the agent loop.
3. **OpenCode pre-plan** — if the query passes the filters, OpenCode answers directly. 2 rounds of 3 parallel prompts with different strategies. The first result > 100 characters wins.
4. **Language formatting** — if OpenCode returned a result, it's passed through Ollama in a clean formatting prompt (no agent system prompt) for language-matched output.

### Failure handling (5-tier priority system)

When Ollama produces text without calling a tool:

| Priority | Condition | Action |
|---|---|---|
| 0 | Fabricated content without tool call | Create dynamic tool via OpenCode, inject it |
| 1 | Previous tool was weak AND model is advisory/giving up | Create dynamic tool via OpenCode |
| 2 | Advisory text ("you can try…", "here are some resources…") | Re-prompt with force-tool message |
| 3 | Weak tool result (empty, "not found", < 30 chars) | Re-prompt with PERSIST_MSG |
| 4 | Giving-up text ("I couldn't find…") | Re-prompt with PERSIST_MSG |

Dynamic tools are created via `askOpencode()` (OpenCode CLI). Up to 3 attempts per conversation. Tools that return 0 characters are auto-unregistered.

### Advisory classification

`classifyAdvisory()` asks Ollama to label the response as ADVISORY (suggesting but not doing) or ANSWER (direct reply). Success confirmations fast-path skip the classifier. Regex fallback on API error.

### Context summarization

When the message history exceeds ~8000 characters:

1. Old messages (before the last 2 exchanges) are sent to Ollama for summarization
2. The summary replaces those messages, keeping the last 4 messages intact
3. Triggers automatically — no manual intervention needed

### RAG integration

On each turn:

1. The last user message is embedded via Ollama embeddings API
2. Similar past tool results are retrieved from SQLite (cosine similarity > threshold)
3. Knowledge chunks from uploaded documents are retrieved via FTS5 + vector search
4. Relevant memories and chunks are injected into the system prompt

## WebSocket handler (`src/ws.ts`)

Handles `ws://host/ws` connections:

```
Client → { type: "chat", sessionId, message }
Server → StreamChunk events → { type: "text" | "tool_start" | "tool_chunk" | "tool_end" | "tool_error" | "status" | "done" | "error" }
```

- 15-second keepalive ping prevents idle disconnects
- Busy lock rejects concurrent chat requests on the same socket
- `tool_end` results are collected and stored as JSON in `tool_results` column
- Assistant responses are persisted to SQLite on completion

## Database (`src/db.ts`)

SQLite with WAL mode. Schema auto-created on startup.

### Tables

| Table | Purpose |
|---|---|
| `sessions` | Chat sessions (name, model, timestamps) |
| `messages` | Conversation messages (role, content, `tool_results` JSON) |
| `memory_entries` | Embedded tool results for RAG retrieval |
| `memory_fts` | FTS5 virtual table for memory keyword search |
| `knowledge_documents` | Uploaded document metadata |
| `knowledge_chunks` | Document chunks with embeddings for vector search |
| `knowledge_fts` | FTS5 virtual table for knowledge keyword search |
| `background_tasks` | Scheduled/recurring tasks (schedule, tool, args) |
| `task_executions` | Execution history per task (status, result, error, timestamps) |
| `tool_calls` | Audit log of every tool invocation |

### Embedding cache

500-entry LRU cache for embedding vectors. Avoids re-embedding identical content.

## Background scheduler (`src/scheduler.ts`)

Polls every 30 seconds for due tasks. Schedule formats:

- `every Xm` / `every Xh` — interval-based
- `daily at HH:MM` / `daily` — time-of-day
- `weekly` — 7-day interval
- Cron expressions (5-field format)

### Retry logic

On failure: exponential backoff → 1min, 5min, 15min, 30min, 60min. Max retries configurable via `task.maxRetries`.

### Result injection

Task results are stored as system messages in the task's session, visible on the next conversation turn.

## Plugin system (`src/plugins.ts`)

Scans `plugins/` and `~/.localclaw/plugins/` on startup. Supports:

- Single `.js`/`.mjs` files exporting `ToolModule`
- Directory packages with `package.json` → `main` entry
- Factory functions returning `ToolModule`

See [docs/plugins.md](plugins.md) for the full plugin format and examples.

## ToolResult widget pattern

Tools can return structured `widget` data alongside the text `result`:

```ts
{ result: 'Text for LLM', widget: { type: 'weather', data: { city, temp, ... } } }
```

- `result` → LLM sees this for reasoning
- `widget` → frontend renders this as a native component

Widgets are persisted in the `tool_results` JSON column and reconstructed on page reload. See `components/weather-widget/` for the reference frontend implementation.

## Fallback chain

When the agent loop gets stuck (empty responses, fabrication, weak results):

1. Pre-plan (OpenCode) → tries to answer directly
2. Agent loop → tries up to 15 iterations with re-prompts
3. `askOpencode()` → one-shot OpenCode call for a direct answer
4. Empty response handling → `emptyCount` tracking → force-tool re-prompt

## OpenCode integration (`src/opencode.ts`)

OpenCode is a separate CLI agent (often using Claude) for complex tasks:

- **Pre-planning** — parallel prompts, >100 char gate
- **Dynamic tools** — creates JS/bash tools when the model needs new capabilities
- **Fallback answering** — direct answer when the agent loop is stuck

Environment variables:
- `LOCALCLAW_OPENCODE_BIN` — binary path (default: `opencode`)
- `LOCALCLAW_OPENCODE_API_KEY` — forwarded as `ANTHROPIC_API_KEY` for Claude models
