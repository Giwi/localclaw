# Database

SQLite (via `better-sqlite3`) with WAL mode. Auto-created at startup in `<dataDir>/localclaw.db`.

## Schema

### `sessions`

Chat session records.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY |
| `name` | TEXT | NOT NULL DEFAULT 'New Session' |
| `model` | TEXT | NOT NULL |
| `created_at` | TEXT | NOT NULL DEFAULT datetime('now') |
| `updated_at` | TEXT | NOT NULL DEFAULT datetime('now') |

### `messages`

Conversation messages (user, assistant, system).

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY |
| `session_id` | TEXT | NOT NULL, FK → sessions(id) ON DELETE CASCADE |
| `role` | TEXT | NOT NULL, CHECK(IN 'user','assistant','system') |
| `content` | TEXT | NOT NULL |
| `tool_results` | TEXT | JSON array of `{toolName, toolResult, widget?}` |
| `created_at` | TEXT | NOT NULL DEFAULT datetime('now') |

Index: `idx_messages_session` on `(session_id, created_at)`.

The `tool_results` column stores tool execution results as JSON, enabling widgets (weather, etc.) to survive page reload. Columns added via `ALTER TABLE` migration at startup if missing.

### `memory_entries`

Embedded tool results for RAG retrieval (session-scoped memory).

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY |
| `session_id` | TEXT | NOT NULL, FK → sessions(id) ON DELETE CASCADE |
| `content` | TEXT | NOT NULL |
| `embedding` | TEXT | JSON array of float32 |
| `created_at` | TEXT | NOT NULL DEFAULT datetime('now') |

Index: `idx_memory_session` on `(session_id, created_at)`.

Tool results < 2000 chars are embedded and stored. The content field holds a truncated version (< 500 chars) for efficient retrieval.

### `knowledge_documents`

Metadata for uploaded knowledge base documents.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY |
| `name` | TEXT | NOT NULL |
| `type` | TEXT | NOT NULL (e.g. 'text', 'pdf', 'docx') |
| `size` | INTEGER | NOT NULL DEFAULT 0 |
| `created_at` | TEXT | NOT NULL DEFAULT datetime('now') |

Index: `idx_knowledge_docs` on `(created_at)`.

### `knowledge_chunks`

Document chunks with embedding vectors for semantic search.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY |
| `document_id` | TEXT | NOT NULL, FK → knowledge_documents(id) ON DELETE CASCADE |
| `content` | TEXT | NOT NULL (~500 chars per chunk) |
| `embedding` | TEXT | JSON array of float32 |
| `created_at` | TEXT | NOT NULL DEFAULT datetime('now') |

Index: `idx_knowledge_chunks_doc` on `(document_id)`.

Documents are chunked at ~500 characters with word-boundary overlap. Supported upload formats: `.txt`, `.md`, `.pdf`, `.docx`.

### `background_tasks`

Scheduled and recurring tasks managed by the background scheduler.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY |
| `session_id` | TEXT | NOT NULL, FK → sessions(id) ON DELETE CASCADE |
| `name` | TEXT | NOT NULL |
| `schedule` | TEXT | NOT NULL (e.g. 'every 30m', 'daily at 08:00') |
| `tool_name` | TEXT | NOT NULL |
| `tool_args` | TEXT | NOT NULL DEFAULT '{}' (JSON) |
| `enabled` | INTEGER | NOT NULL DEFAULT 1 |
| `last_run_at` | TEXT | nullable |
| `next_run_at` | TEXT | nullable |
| `last_result` | TEXT | nullable |
| `last_error` | TEXT | nullable |
| `retries` | INTEGER | NOT NULL DEFAULT 0 |
| `max_retries` | INTEGER | NOT NULL DEFAULT 3 |
| `created_at` | TEXT | NOT NULL DEFAULT datetime('now') |

Index: `idx_bg_tasks_next` on `(enabled, next_run_at)` for efficient due-task polling.

### `task_executions`

Execution history per background task.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY |
| `task_id` | TEXT | NOT NULL, FK → background_tasks(id) ON DELETE CASCADE |
| `status` | TEXT | NOT NULL, CHECK(IN 'running','success','failed') |
| `result` | TEXT | nullable |
| `error` | TEXT | nullable |
| `started_at` | TEXT | NOT NULL |
| `finished_at` | TEXT | nullable |

Index: `idx_task_executions_task` on `(task_id, started_at)`.

### `tool_calls`

Audit log of every tool invocation from the agent loop.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY |
| `session_id` | TEXT | FK → sessions(id) ON DELETE SET NULL |
| `tool_name` | TEXT | NOT NULL |
| `tool_args` | TEXT | NOT NULL DEFAULT '{}' (JSON) |
| `tool_result` | TEXT | nullable |
| `tool_error` | TEXT | nullable |
| `duration_ms` | INTEGER | NOT NULL DEFAULT 0 |
| `created_at` | TEXT | NOT NULL DEFAULT datetime('now') |

Index: `idx_tool_calls_session` on `(session_id, created_at)`.

### FTS5 virtual tables

Two full-text search indices for hybrid retrieval:

- **`memory_fts`** — indexes `content` column from `memory_entries`, scoped by `session_id` (UNINDEXED)
- **`knowledge_fts`** — indexes `content` column from `knowledge_chunks`, scoped by `document_id` (UNINDEXED)

FTS5 enables fast keyword search alongside cosine-similarity embedding search.

## Embedding cache

A 500-entry LRU in-memory cache (`Map<string, number[]>`) avoids re-embedding identical content. When the cache exceeds 500 entries, the oldest entry is evicted (FIFO). Cache is not persisted across restarts.

## Migrations

Schema is created on first startup via `CREATE TABLE IF NOT EXISTS`. Column additions use `ALTER TABLE ... ADD COLUMN` wrapped in try/catch (e.g. `tool_results` added to `messages`). No down-migrations or version tracking — additive only.

## Functions

Key DB functions:

| Function | File | Purpose |
|----------|------|---------|
| `openDb(dataDir)` | `db.ts:50` | Open/create DB, run schema DDL |
| `createSession(db, model, name?)` | `db.ts:147` | Create new chat session |
| `listSessions(db)` | `db.ts:156` | List sessions ordered by update |
| `getSession(db, id)` | `db.ts:163` | Get session by ID |
| `deleteSession(db, id)` | `db.ts:174` | Delete session + cascade messages |
| `addMessage(db, msg)` | `db.ts:201` | Insert message with optional tool_results |
| `getMessages(db, sessionId)` | `db.ts:213` | Get messages ordered by created_at |
| `deleteMessagesAfter(db, sessionId, msgId)` | `db.ts:179` | Truncate after edit point |
| `storeMemory(db, sessionId, content, emb)` | `db.ts:238` | Store memory + FTS5 entry |
| `searchMemory(db, sessionId, emb, limit?)` | `db.ts:249` | Cosine similarity search |
| `addKnowledgeDocument(db, name, type, size)` | `db.ts:266` | Create knowledge doc record |
| `addKnowledgeChunk(db, docId, content, emb)` | `db.ts:272` | Store chunk + FTS5 entry |
| `searchKnowledge(db, emb, limit?)` | `db.ts:282` | Global knowledge search |
| `createBackgroundTask(db, task)` | `db.ts:292` | Create scheduled task |
| `listBackgroundTasks(db, sessionId?)` | `db.ts:276` | List tasks, optionally per session |
| `getBackgroundTask(db, id)` | `db.ts:286` | Get single task |
| `updateBackgroundTask(db, id, updates)` | `db.ts:298` | Update task fields |
| `deleteBackgroundTask(db, id)` | `db.ts:306` | Delete task |
| `addTaskExecution(db, taskId, status, result?, error?)` | `db.ts:310` | Start an execution |
| `getTaskExecutions(db, taskId, limit?)` | `db.ts:319` | Get last N executions |
| `updateTaskExecution(db, id, status, result?, error?)` | `db.ts:325` | Mark execution complete |
| `addToolCall(db, call)` | `db.ts:186` | Log tool invocation |
| `searchToolCalls(db, sessionId, query?)` | `db.ts:196` | Search audit log |
