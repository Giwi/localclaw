import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import type { Message, Session, BackgroundTask } from './types.js'
import { embed } from './embeddings.js'
import { log } from './log.js'

// Simple in-memory embedding cache: content → number[]
const embedCache = new Map<string, number[]>()

export function clearEmbedCache() {
  embedCache.clear()
}

function parseEmbedding(raw: string | null): number[] | null {
  if (!raw) return null
  const cached = embedCache.get(raw)
  if (cached) return cached
  try {
    const parsed = JSON.parse(raw) as number[]
    if (parsed.length > 0) embedCache.set(raw, parsed)
    return parsed
  } catch {
    return null
  }
}

export function openDb(dataDir: string): BetterSqlite3.Database {
  fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, 'localclaw.db')
  log.info(`Opening database: ${dbPath}`)
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
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
  `)

  log.debug('Database schema ready')

  // Backfill any embeddings computed externally
  backfillMissingEmbeddings(db)

  return db
}

export function createSession(db: BetterSqlite3.Database, model: string, name?: string): Session {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO sessions (id, name, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, name || 'New Session', model, now, now)
  return { id, name: name || 'New Session', model, createdAt: now, updatedAt: now }
}

export function listSessions(db: BetterSqlite3.Database): Session[] {
  return db
    .prepare('SELECT id, name, model, created_at, updated_at FROM sessions ORDER BY updated_at DESC')
    .all()
    .map(mapSession)
}

export function getSession(db: BetterSqlite3.Database, id: string): Session | null {
  const row = db
    .prepare('SELECT id, name, model, created_at, updated_at FROM sessions WHERE id = ?')
    .get(id)
  return row ? mapSession(row as any) : null
}

export function updateSessionName(db: BetterSqlite3.Database, id: string, name: string) {
  db.prepare("UPDATE sessions SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id)
}

export function deleteSession(db: BetterSqlite3.Database, id: string) {
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(id)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

export function deleteMessagesAfter(db: BetterSqlite3.Database, sessionId: string, messageId: string) {
  const msg = db.prepare('SELECT created_at FROM messages WHERE id = ?').get(messageId) as { created_at: string } | undefined
  if (!msg) return
  db.prepare('DELETE FROM messages WHERE session_id = ? AND created_at > ?').run(sessionId, msg.created_at)
}

export function addToolCall(db: BetterSqlite3.Database, call: {
  sessionId: string | null
  toolName: string
  toolArgs: string
  toolResult?: string
  toolError?: string
  durationMs: number
}): void {
  const id = crypto.randomUUID()
  db.prepare(
    `INSERT INTO tool_calls (id, session_id, tool_name, tool_args, tool_result, tool_error, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, call.sessionId, call.toolName, call.toolArgs, call.toolResult || null, call.toolError || null, call.durationMs, new Date().toISOString())
}

export function addMessage(
  db: BetterSqlite3.Database,
  msg: Omit<Message, 'id' | 'createdAt'>
): Message {
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  db.prepare(
    'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, msg.sessionId, msg.role, msg.content, createdAt)
  return { ...msg, id, createdAt }
}

export function getMessages(db: BetterSqlite3.Database, sessionId: string): Message[] {
  return db
    .prepare(
      'SELECT id, session_id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at'
    )
    .all(sessionId)
    .map(mapMessage)
}

function mapSession(row: any): Session {
  return { id: row.id, name: row.name, model: row.model, createdAt: row.created_at, updatedAt: row.updated_at }
}

function mapMessage(row: any): Message {
  return { id: row.id, sessionId: row.session_id, role: row.role, content: row.content, createdAt: row.created_at }
}

export function storeMemory(db: BetterSqlite3.Database, sessionId: string, content: string, embedding?: number[]) {
  const id = crypto.randomUUID()
  db.prepare(
    'INSERT INTO memory_entries (id, session_id, content, embedding, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, sessionId, content, embedding ? JSON.stringify(embedding) : null, new Date().toISOString())
  try {
    db.prepare('INSERT INTO memory_fts (rowid, content, session_id) VALUES (?, ?, ?)').run(
      db.prepare('SELECT rowid FROM memory_entries WHERE id = ?').get(id) as any,
      content,
      sessionId,
    )
  } catch { /* FTS may not be available */ }
}

export function searchMemories(db: BetterSqlite3.Database, sessionId: string, queryEmbedding: number[], limit = 5): { content: string; score: number }[] {
  const rows = db.prepare(
    'SELECT content, embedding FROM memory_entries WHERE session_id = ? AND embedding IS NOT NULL ORDER BY created_at DESC LIMIT 50'
  ).all(sessionId) as { content: string; embedding: string }[]

  const scored: { content: string; score: number }[] = []
  for (const row of rows) {
    const emb = parseEmbedding(row.embedding)
    if (emb) {
      const score = cosineSimilarity(queryEmbedding, emb)
      scored.push({ content: row.content, score })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

export function createBackgroundTask(
  db: BetterSqlite3.Database,
  task: Omit<BackgroundTask, 'id' | 'createdAt' | 'lastRunAt' | 'lastResult' | 'lastError' | 'retries' | 'maxRetries'>
): BackgroundTask {
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO background_tasks (id, session_id, name, schedule, tool_name, tool_args, enabled, next_run_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, task.sessionId, task.name, task.schedule, task.toolName, task.toolArgs, task.enabled ? 1 : 0, task.nextRunAt || null, createdAt)
  return { ...task, id, createdAt, lastRunAt: null, lastResult: null, lastError: null, retries: 0, maxRetries: 3 }
}

export function listBackgroundTasks(db: BetterSqlite3.Database, sessionId?: string): BackgroundTask[] {
  let rows: any[]
  if (sessionId) {
    rows = db.prepare('SELECT * FROM background_tasks WHERE session_id = ? ORDER BY created_at DESC').all(sessionId)
  } else {
    rows = db.prepare('SELECT * FROM background_tasks ORDER BY created_at DESC').all()
  }
  return rows.map(mapBackgroundTask)
}

export function getBackgroundTask(db: BetterSqlite3.Database, id: string): BackgroundTask | null {
  const row = db.prepare('SELECT * FROM background_tasks WHERE id = ?').get(id)
  return row ? mapBackgroundTask(row as any) : null
}

export function updateBackgroundTask(db: BetterSqlite3.Database, id: string, updates: Partial<Pick<BackgroundTask, 'lastRunAt' | 'lastResult' | 'lastError' | 'nextRunAt' | 'enabled' | 'retries' | 'maxRetries'>>): void {
  const sets: string[] = []
  const vals: any[] = []
  if (updates.lastRunAt !== undefined) { sets.push('last_run_at = ?'); vals.push(updates.lastRunAt) }
  if (updates.lastResult !== undefined) { sets.push('last_result = ?'); vals.push(updates.lastResult) }
  if (updates.lastError !== undefined) { sets.push('last_error = ?'); vals.push(updates.lastError) }
  if (updates.nextRunAt !== undefined) { sets.push('next_run_at = ?'); vals.push(updates.nextRunAt) }
  if (updates.enabled !== undefined) { sets.push('enabled = ?'); vals.push(updates.enabled ? 1 : 0) }
  if (updates.retries !== undefined) { sets.push('retries = ?'); vals.push(updates.retries) }
  if (updates.maxRetries !== undefined) { sets.push('max_retries = ?'); vals.push(updates.maxRetries) }
  if (sets.length === 0) return
  vals.push(id)
  db.prepare(`UPDATE background_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

export function deleteBackgroundTask(db: BetterSqlite3.Database, id: string): void {
  db.prepare('DELETE FROM background_tasks WHERE id = ?').run(id)
}

export function getDueTasks(db: BetterSqlite3.Database): BackgroundTask[] {
  const rows = db.prepare(
    "SELECT * FROM background_tasks WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= datetime('now'))"
  ).all()
  return rows.map(mapBackgroundTask)
}

function mapBackgroundTask(row: any): BackgroundTask {
  return {
    id: row.id,
    sessionId: row.session_id,
    name: row.name,
    schedule: row.schedule,
    toolName: row.tool_name,
    toolArgs: row.tool_args,
    enabled: !!row.enabled,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    lastResult: row.last_result,
    lastError: row.last_error,
    retries: row.retries ?? 0,
    maxRetries: row.max_retries ?? 3,
    createdAt: row.created_at,
  }
}

export function addKnowledgeDocument(db: BetterSqlite3.Database, name: string, type: string, size: number): { id: string } {
  const id = crypto.randomUUID()
  db.prepare('INSERT INTO knowledge_documents (id, name, type, size) VALUES (?, ?, ?, ?)').run(id, name, type, size)
  return { id }
}

export function addKnowledgeChunk(db: BetterSqlite3.Database, documentId: string, content: string, embedding?: number[]) {
  const id = crypto.randomUUID()
  db.prepare(
    'INSERT INTO knowledge_chunks (id, document_id, content, embedding) VALUES (?, ?, ?, ?)'
  ).run(id, documentId, content, embedding ? JSON.stringify(embedding) : null)
  try {
    db.prepare('INSERT INTO knowledge_fts (rowid, content, document_id) VALUES (?, ?, ?)').run(
      db.prepare('SELECT rowid FROM knowledge_chunks WHERE id = ?').get(id) as any,
      content,
      documentId,
    )
  } catch { /* FTS may not be available */ }
}

export function listKnowledgeDocuments(db: BetterSqlite3.Database): { id: string; name: string; type: string; size: number; createdAt: string }[] {
  return db.prepare('SELECT id, name, type, size, created_at FROM knowledge_documents ORDER BY created_at DESC').all()
    .map((r: any) => ({ id: r.id, name: r.name, type: r.type, size: r.size, createdAt: r.created_at }))
}

export function deleteKnowledgeDocument(db: BetterSqlite3.Database, id: string) {
  db.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(id)
  db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(id)
}

export function searchKnowledge(db: BetterSqlite3.Database, queryEmbedding: number[], limit = 5): { content: string; score: number; documentName: string }[] {
  const rows = db.prepare(
    `SELECT kc.content, kc.embedding, kd.name as document_name
     FROM knowledge_chunks kc
     JOIN knowledge_documents kd ON kd.id = kc.document_id
     WHERE kc.embedding IS NOT NULL
     ORDER BY kc.created_at DESC LIMIT 100`
  ).all() as { content: string; embedding: string; document_name: string }[]

  const scored: { content: string; score: number; documentName: string }[] = []
  for (const row of rows) {
    const emb = parseEmbedding(row.embedding)
    if (emb) {
      const score = cosineSimilarity(queryEmbedding, emb)
      if (score > 0.1) scored.push({ content: row.content, score, documentName: row.document_name })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

export function backfillMissingEmbeddings(db: BetterSqlite3.Database) {
  const tables = [
    { table: 'memory_entries', idField: 'id', contentField: 'content' },
    { table: 'knowledge_chunks', idField: 'id', contentField: 'content' },
  ]

  for (const { table, idField, contentField } of tables) {
    const rows = db.prepare(
      `SELECT ${idField} as id, ${contentField} as content FROM ${table} WHERE embedding IS NULL LIMIT 50`
    ).all() as { id: string; content: string }[]

    for (const row of rows) {
      embed(row.content.slice(0, 1000)).then((emb) => {
        if (emb.length > 0) {
          db.prepare(`UPDATE ${table} SET embedding = ? WHERE ${idField} = ?`).run(JSON.stringify(emb), row.id)
        }
      }).catch(() => {})
    }

    if (rows.length > 0) log.debug(`Backfilling ${rows.length} embeddings for ${table}`)
  }
}
