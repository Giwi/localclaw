import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import type { Message, Session } from './types.js'
import { log } from './log.js'

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
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
  `)

  log.debug('Database schema ready')
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
