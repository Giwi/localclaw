# API Reference

All REST endpoints (except `/api/health`) require authentication when `LOCALCLAW_API_KEY` is set. Pass the key as a Bearer token:

```
Authorization: Bearer <your-api-key>
```

## REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/tools` | List registered tools |
| `GET` | `/api/sessions` | List sessions |
| `POST` | `/api/sessions` | Create session |
| `GET` | `/api/sessions/:id` | Get session |
| `DELETE` | `/api/sessions/:id` | Delete session |
| `PATCH` | `/api/sessions/:id` | Rename session |
| `GET` | `/api/sessions/:id/messages` | Get messages |
| `PATCH` | `/api/sessions/:id/messages/:msgId` | Edit message (truncates conversation after it) |
| `POST` | `/api/sessions/:id/upload` | Upload file (txt/pdf/docx) for chat context |
| `GET` | `/api/background-tasks` | List background tasks |
| `GET` | `/api/background-tasks/:id` | Get a background task |
| `GET` | `/api/background-tasks/:id/logs` | Get a task's execution history |
| `POST` | `/api/background-tasks/:id/run` | Manually trigger a task run |
| `DELETE` | `/api/background-tasks/:id` | Delete a background task |
| `PATCH` | `/api/background-tasks/:id` | Enable/disable (pause/resume) a task |
| `GET` | `/api/sessions/:id/proactive` | Get proactive summary (upcoming tasks) |
| `GET` | `/api/knowledge` | List uploaded knowledge documents |
| `POST` | `/api/knowledge/upload` | Upload file to knowledge base |
| `DELETE` | `/api/knowledge/:id` | Delete a knowledge document |

## Chat Streaming (WebSocket)

Connect to `ws://host/ws` and send a JSON message:

```json
{"type":"chat","sessionId":"<uuid>","message":"Hello!"}
```

The server streams events back as JSON messages:

```
{"type":"text","content":"thinking..."}
{"type":"tool_start","toolName":"web_fetch","toolRunId":"<uuid>","toolArgs":{...}}
{"type":"tool_chunk","toolName":"web_fetch","toolRunId":"<uuid>","content":"stdout line 1..."}
{"type":"tool_end","toolName":"web_fetch","toolRunId":"<uuid>","toolResult":"...","widget":{...}}
{"type":"tool_error","toolName":"web_fetch","toolRunId":"<uuid>","error":"..."}
{"type":"text","content":"final answer"}
{"type":"done"}
```

Event types:

| Event | Fields | Description |
|-------|--------|-------------|
| `text` | `content` | Streaming text from the LLM response |
| `tool_start` | `toolName`, `toolRunId`, `toolArgs` | Tool invocation started |
| `tool_chunk` | `toolName`, `toolRunId`, `content` | Streaming output from tool execution |
| `tool_end` | `toolName`, `toolRunId`, `toolResult`, `widget?` | Tool completed with result |
| `tool_error` | `toolName`, `toolRunId`, `error` | Tool execution failed |
| `status` | `content` | Progress messages (e.g. "Analyzing...") |
| `done` | — | Stream complete |
| `error` | `error` | Fatal error, stream terminated |

Each tool invocation gets a unique `toolRunId` so concurrent or repeated tool calls are matched correctly in the UI. Tool execution output is streamed in real-time via `tool_chunk` events.

**Keepalive**: 15-second ping interval prevents idle disconnects.

**Stop generation**: Close the WebSocket from the client side — the backend detects `req.on('close')` and aborts the agent loop.

**Development proxy**: When using `ng serve`, the Angular dev server proxies `/ws` to the backend. Configured in `client/proxy.conf.js`.

## WebSocket Authentication

When `LOCALCLAW_API_KEY` is set, WebSocket connections require authentication before chat messages are accepted:

```json
{"type":"auth","token":"<api-key>"}
```

The server responds with `{"type":"auth_ok"}` on success or closes the connection on failure.

## Busy lock

Only one chat request per WebSocket connection at a time. Concurrent requests on the same socket are rejected until the current one completes.
