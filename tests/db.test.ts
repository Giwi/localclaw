import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'
import os from 'os'
import {
  openDb, createSession, listSessions, getSession, updateSessionName,
  deleteSession, addMessage, getMessages, deleteMessagesAfter,
  addToolCall, createBackgroundTask, listBackgroundTasks, getBackgroundTask,
  updateBackgroundTask, deleteBackgroundTask, getDueTasks,
  addKnowledgeDocument, addKnowledgeChunk, listKnowledgeDocuments,
  deleteKnowledgeDocument, searchMemories, searchKnowledge,
  storeMemory, clearEmbedCache, addTaskExecution, getTaskExecutions,
  updateTaskExecution,
} from '../src/db.js'

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT 'Untitled',
    model TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    embedding TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS background_tasks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    schedule TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tool_args TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    next_run_at TEXT,
    last_result TEXT,
    last_error TEXT,
    retries INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_memory_session ON memory_entries(session_id, created_at);
  CREATE TABLE IF NOT EXISTS knowledge_documents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    embedding TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bg_tasks_next ON background_tasks(enabled, next_run_at);
  CREATE INDEX IF NOT EXISTS idx_knowledge_docs ON knowledge_documents(created_at);
  CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(document_id);
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, session_id UNINDEXED);
  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(content, document_id UNINDEXED);
  CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    tool_name TEXT NOT NULL,
    tool_args TEXT NOT NULL DEFAULT '{}',
    tool_result TEXT,
    tool_error TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, created_at);
  CREATE TABLE IF NOT EXISTS task_executions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES background_tasks(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('running','success','failed')),
    result TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_task_executions_task ON task_executions(task_id, started_at);
`

function createMemoryDb(): BetterSqlite3.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA_SQL)
  return db
}

describe('openDb', () => {
  let tempDir: string

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates schema tables', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localclaw-test-'))
    const db = openDb(tempDir)

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
    const tableNames = tables.map(t => t.name)
    expect(tableNames).toContain('sessions')
    expect(tableNames).toContain('messages')
    expect(tableNames).toContain('memory_entries')
    expect(tableNames).toContain('background_tasks')
    expect(tableNames).toContain('knowledge_documents')
    expect(tableNames).toContain('knowledge_chunks')
    expect(tableNames).toContain('tool_calls')
    expect(tableNames).toContain('task_executions')

    const ftsTables = db.prepare("SELECT name FROM sqlite_master WHERE name IN ('memory_fts', 'knowledge_fts')").all() as { name: string }[]
    const ftsNames = ftsTables.map(t => t.name)
    expect(ftsNames).toContain('memory_fts')
    expect(ftsNames).toContain('knowledge_fts')

    db.close()
  })
})

describe('session operations', () => {
  let db: BetterSqlite3.Database

  beforeAll(() => { db = createMemoryDb() })

  it('creates a session', () => {
    const session = createSession(db, 'test-model', 'Test Session')
    expect(session.id).toBeDefined()
    expect(session.name).toBe('Test Session')
    expect(session.model).toBe('test-model')
    expect(session.createdAt).toBeDefined()
    expect(session.updatedAt).toBeDefined()
  })

  it('creates a session with default name', () => {
    const session = createSession(db, 'llama3')
    expect(session.name).toBe('New Session')
  })

  it('lists all sessions', () => {
    const s1 = createSession(db, 'model-a', 'Session A')
    const s2 = createSession(db, 'model-b', 'Session B')
    const sessions = listSessions(db)
    expect(sessions.length).toBeGreaterThanOrEqual(2)
    const names = sessions.map(s => s.name)
    expect(names).toContain('Session A')
    expect(names).toContain('Session B')
  })

  it('gets a session by id', () => {
    const created = createSession(db, 'gpt-4', 'Get Me')
    const found = getSession(db, created.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
    expect(found!.name).toBe('Get Me')
  })

  it('returns null for non-existent session', () => {
    expect(getSession(db, 'nonexistent-id')).toBeNull()
  })

  it('updates session name', () => {
    const session = createSession(db, 'model-x', 'Old Name')
    updateSessionName(db, session.id, 'New Name')
    const updated = getSession(db, session.id)
    expect(updated!.name).toBe('New Name')
  })

  it('deletes a session and its messages', () => {
    const session = createSession(db, 'model-del', 'Delete Me')
    addMessage(db, { sessionId: session.id, role: 'user', content: 'msg' })
    deleteSession(db, session.id)
    expect(getSession(db, session.id)).toBeNull()
    expect(getMessages(db, session.id)).toHaveLength(0)
  })
})

describe('message operations', () => {
  let db: BetterSqlite3.Database
  let sessionId: string

  beforeAll(() => {
    db = createMemoryDb()
    sessionId = createSession(db, 'chat-model').id
  })

  it('adds a message', () => {
    const msg = addMessage(db, { sessionId, role: 'user', content: 'Hello' })
    expect(msg.id).toBeDefined()
    expect(msg.role).toBe('user')
    expect(msg.content).toBe('Hello')
    expect(msg.sessionId).toBe(sessionId)
  })

  it('gets messages in order', () => {
    const msgs = getMessages(db, sessionId)
    expect(msgs.length).toBeGreaterThanOrEqual(1)
    expect(msgs[0].role).toBe('user')
  })

  it('adds assistant and system messages', () => {
    const assistant = addMessage(db, { sessionId, role: 'assistant', content: 'Hi there' })
    expect(assistant.role).toBe('assistant')
    const system = addMessage(db, { sessionId, role: 'system', content: 'beep boop' })
    expect(system.role).toBe('system')
  })

  it('deleteMessagesAfter removes subsequent messages', () => {
    const session = createSession(db, 'test')
    const t1 = new Date(Date.now() - 5000).toISOString()
    const t2 = new Date(Date.now() - 4000).toISOString()
    const t3 = new Date(Date.now() - 3000).toISOString()

    const aid = crypto.randomUUID()
    const bid = crypto.randomUUID()
    const cid = crypto.randomUUID()
    db.prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(aid, session.id, 'user', 'first', t1)
    db.prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(bid, session.id, 'user', 'second', t2)
    db.prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(cid, session.id, 'user', 'third', t3)

    deleteMessagesAfter(db, session.id, bid)

    const remaining = getMessages(db, session.id)
    expect(remaining).toHaveLength(2)
    expect(remaining[0].id).toBe(aid)
    expect(remaining[1].id).toBe(bid)
  })
})

describe('tool call operations', () => {
  let db: BetterSqlite3.Database

  beforeAll(() => { db = createMemoryDb() })

  it('adds a tool call', () => {
    addToolCall(db, {
      sessionId: null,
      toolName: 'test_tool',
      toolArgs: '{"key":"val"}',
      toolResult: 'success',
      durationMs: 100,
    })

    const rows = db.prepare('SELECT * FROM tool_calls').all() as any[]
    expect(rows.length).toBe(1)
    expect(rows[0].tool_name).toBe('test_tool')
    expect(rows[0].tool_result).toBe('success')
    expect(rows[0].duration_ms).toBe(100)
  })

  it('adds a tool call with error', () => {
    addToolCall(db, {
      sessionId: null,
      toolName: 'failing_tool',
      toolArgs: '{}',
      toolError: 'something broke',
      durationMs: 50,
    })

    const rows = db.prepare("SELECT * FROM tool_calls WHERE tool_name = 'failing_tool'").all() as any[]
    expect(rows[0].tool_error).toBe('something broke')
  })
})

describe('background task operations', () => {
  let db: BetterSqlite3.Database
  let sessionId: string
  let taskId: string

  beforeAll(() => {
    db = createMemoryDb()
    sessionId = createSession(db, 'task-model').id
  })

  it('creates a background task', () => {
    const task = createBackgroundTask(db, {
      sessionId,
      name: 'My Task',
      schedule: 'every 5m',
      toolName: 'test_tool',
      toolArgs: '{}',
      enabled: true,
      nextRunAt: null,
    })
    taskId = task.id
    expect(task.name).toBe('My Task')
    expect(task.schedule).toBe('every 5m')
    expect(task.enabled).toBe(true)
    expect(task.retries).toBe(0)
    expect(task.maxRetries).toBe(3)
  })

  it('lists background tasks', () => {
    const tasks = listBackgroundTasks(db, sessionId)
    expect(tasks.length).toBe(1)
    expect(tasks[0].name).toBe('My Task')
  })

  it('gets a background task by id', () => {
    const task = getBackgroundTask(db, taskId)
    expect(task).not.toBeNull()
    expect(task!.id).toBe(taskId)
  })

  it('returns null for non-existent task', () => {
    expect(getBackgroundTask(db, 'nonexistent')).toBeNull()
  })

  it('updates a background task', () => {
    const future = new Date(Date.now() + 86400000).toISOString()
    updateBackgroundTask(db, taskId, {
      lastRunAt: new Date().toISOString(),
      lastResult: 'done',
      nextRunAt: future,
      retries: 1,
    })
    const task = getBackgroundTask(db, taskId)
    expect(task!.lastResult).toBe('done')
    expect(task!.retries).toBe(1)
  })

  it('deletes a background task', () => {
    const task = createBackgroundTask(db, {
      sessionId,
      name: 'Temp Task',
      schedule: 'daily',
      toolName: 'tool',
      toolArgs: '{}',
      enabled: false,
      nextRunAt: null,
    })
    deleteBackgroundTask(db, task.id)
    expect(getBackgroundTask(db, task.id)).toBeNull()
  })

  it('getDueTasks returns enabled tasks with null next_run_at', () => {
    createBackgroundTask(db, {
      sessionId,
      name: 'Due Task',
      schedule: 'every 1m',
      toolName: 'tool',
      toolArgs: '{}',
      enabled: true,
      nextRunAt: null,
    })
    const due = getDueTasks(db)
    expect(due.some(t => t.name === 'Due Task')).toBe(true)
  })

  it('getDueTasks excludes disabled tasks', () => {
    createBackgroundTask(db, {
      sessionId,
      name: 'Disabled Task',
      schedule: 'every 1m',
      toolName: 'tool',
      toolArgs: '{}',
      enabled: false,
      nextRunAt: null,
    })
    const due = getDueTasks(db)
    expect(due.some(t => t.name === 'Disabled Task')).toBe(false)
  })
})

describe('knowledge document operations', () => {
  let db: BetterSqlite3.Database

  beforeAll(() => { db = createMemoryDb() })

  it('adds a knowledge document', () => {
    const doc = addKnowledgeDocument(db, 'test.txt', 'text', 100)
    expect(doc.id).toBeDefined()
  })

  it('adds a knowledge chunk', () => {
    const doc = addKnowledgeDocument(db, 'doc.txt', 'text', 200)
    addKnowledgeChunk(db, doc.id, 'some content', [0.1, 0.2, 0.3])
    const chunks = db.prepare('SELECT * FROM knowledge_chunks WHERE document_id = ?').all(doc.id) as any[]
    expect(chunks.length).toBe(1)
    expect(chunks[0].content).toBe('some content')
  })

  it('lists knowledge documents', () => {
    const docs = listKnowledgeDocuments(db)
    expect(docs.length).toBeGreaterThanOrEqual(2)
  })

  it('deletes a knowledge document and its chunks', () => {
    const doc = addKnowledgeDocument(db, 'delete-me.txt', 'text', 50)
    addKnowledgeChunk(db, doc.id, 'chunk content')
    deleteKnowledgeDocument(db, doc.id)
    const docs = listKnowledgeDocuments(db)
    expect(docs.some(d => d.id === doc.id)).toBe(false)
  })
})

describe('memory and search operations', () => {
  let db: BetterSqlite3.Database
  let sessionId: string

  beforeAll(() => {
    db = createMemoryDb()
    sessionId = createSession(db, 'mem-model').id
  })

  it('stores a memory with embedding', () => {
    storeMemory(db, sessionId, 'important fact', [1, 0, 0])
    const rows = db.prepare('SELECT * FROM memory_entries WHERE session_id = ?').all(sessionId) as any[]
    expect(rows.length).toBe(1)
    expect(rows[0].content).toBe('important fact')
  })

  it('stores a memory without embedding', () => {
    storeMemory(db, sessionId, 'no embedding fact')
    const rows = db.prepare('SELECT * FROM memory_entries WHERE session_id = ? AND embedding IS NULL').all(sessionId) as any[]
    expect(rows.length).toBe(1)
  })

  it('searchMemories returns results sorted by relevance', () => {
    storeMemory(db, sessionId, 'cat', [1, 0, 0])
    storeMemory(db, sessionId, 'dog', [0, 1, 0])

    const results = searchMemories(db, sessionId, [1, 0, 0], 5)
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].content).toBe('cat')
    expect(results[0].score).toBeGreaterThan(0)
  })

  it('searchMemories returns empty array for no matching session', () => {
    const results = searchMemories(db, 'nonexistent', [1, 0, 0], 5)
    expect(results).toHaveLength(0)
  })

  it('searchKnowledge returns documents sorted by relevance', () => {
    const doc = addKnowledgeDocument(db, 'search-test.txt', 'text', 100)
    addKnowledgeChunk(db, doc.id, 'apple fruit', [1, 0, 0])
    addKnowledgeChunk(db, doc.id, 'car vehicle', [0, 1, 0])

    const results = searchKnowledge(db, [1, 0, 0], 5)
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].content).toBe('apple fruit')
  })

  it('searchKnowledge filters low-relevance results', () => {
    const doc = addKnowledgeDocument(db, 'low-rel.txt', 'text', 50)
    addKnowledgeChunk(db, doc.id, 'noise', [0.01, 0, 0])

    const results = searchKnowledge(db, [0, 1, 0], 5)
    expect(results.some(r => r.content === 'noise')).toBe(false)
  })
})

describe('task execution operations', () => {
  let db: BetterSqlite3.Database
  let taskId: string

  beforeAll(() => {
    db = createMemoryDb()
    const sessionId = createSession(db, 'exec-model').id
    const task = createBackgroundTask(db, {
      sessionId,
      name: 'Exec Task',
      schedule: 'every 1m',
      toolName: 'tool',
      toolArgs: '{}',
      enabled: true,
      nextRunAt: null,
    })
    taskId = task.id
  })

  it('adds a task execution', () => {
    const execId = addTaskExecution(db, taskId, 'running')
    expect(execId).toBeDefined()
  })

  it('gets task executions', () => {
    addTaskExecution(db, taskId, 'success', 'done')
    const execs = getTaskExecutions(db, taskId)
    expect(execs.length).toBe(2)
    expect(execs[0].status).toBe('success')
    expect(execs[0].result).toBe('done')
  })

  it('updates a task execution', () => {
    const execId = addTaskExecution(db, taskId, 'running')
    updateTaskExecution(db, execId, 'success', 'completed')
    const execs = getTaskExecutions(db, taskId)
    const updated = execs.find(e => e.id === execId)
    expect(updated!.status).toBe('success')
    expect(updated!.result).toBe('completed')
    expect(updated!.finishedAt).toBeDefined()
  })

  it('updates a task execution with error', () => {
    const execId = addTaskExecution(db, taskId, 'running')
    updateTaskExecution(db, execId, 'failed', undefined, 'error msg')
    const execs = getTaskExecutions(db, taskId)
    const updated = execs.find(e => e.id === execId)
    expect(updated!.status).toBe('failed')
    expect(updated!.error).toBe('error msg')
  })
})

describe('clearEmbedCache', () => {
  it('does not throw', () => {
    expect(() => clearEmbedCache()).not.toThrow()
  })
})
