import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { Agent } from '../src/agent.js'

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT 'Untitled',
    model TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    content TEXT NOT NULL, embedding TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS background_tasks (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name TEXT NOT NULL, schedule TEXT NOT NULL, tool_name TEXT NOT NULL,
    tool_args TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT, next_run_at TEXT, last_result TEXT, last_error TEXT,
    retries INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 3,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_memory_session ON memory_entries(session_id, created_at);
  CREATE TABLE IF NOT EXISTS knowledge_documents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL, embedding TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bg_tasks_next ON background_tasks(enabled, next_run_at);
  CREATE INDEX IF NOT EXISTS idx_knowledge_docs ON knowledge_documents(created_at);
  CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(document_id);
  CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    tool_name TEXT NOT NULL, tool_args TEXT NOT NULL DEFAULT '{}',
    tool_result TEXT, tool_error TEXT, duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, created_at);
  CREATE TABLE IF NOT EXISTS task_executions (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES background_tasks(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('running','success','failed')),
    result TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_task_executions_task ON task_executions(task_id, started_at);
`

describe('Agent', () => {
  let agent: Agent
  let db: BetterSqlite3.Database
  let tempDir: string

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localclaw-agent-test-'))
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    db.exec(SCHEMA_SQL)
    agent = new Agent(tempDir, db)
  })

  afterAll(() => {
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates an Agent with a tool registry', () => {
    expect(agent).toBeInstanceOf(Agent)
    expect(agent.getTools()).toBeDefined()
  })

  it('getTools returns all registered tool definitions', () => {
    const tools = agent.getTools()
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThan(0)

    const names = tools.map(t => t.name)
    expect(names).toContain('read_file')
    expect(names).toContain('write_file')
    expect(names).toContain('run_bash')
    expect(names).toContain('web_fetch')
    expect(names).toContain('create_tool')
  })

  it('each tool has required fields', () => {
    const tools = agent.getTools()
    for (const tool of tools) {
      expect(tool).toHaveProperty('name')
      expect(tool).toHaveProperty('description')
      expect(tool).toHaveProperty('parameters')
      expect(tool.parameters).toHaveProperty('type', 'object')
      expect(tool.parameters).toHaveProperty('properties')
    }
  })

  it('getToolRegistry returns the ToolRegistry instance', () => {
    const registry = agent.getToolRegistry()
    expect(registry).toBeDefined()
    expect(registry.list().length).toBeGreaterThan(0)
  })

  it('buildToolDefs produces Ollama-compatible tool definitions', () => {
    const defs = (agent as any).buildToolDefs()
    expect(Array.isArray(defs)).toBe(true)
    expect(defs.length).toBeGreaterThan(0)

    for (const def of defs) {
      expect(def).toHaveProperty('type', 'function')
      expect(def).toHaveProperty('function')
      expect(def.function).toHaveProperty('name')
      expect(def.function).toHaveProperty('description')
      expect(def.function).toHaveProperty('parameters')
      expect(typeof def.function.name).toBe('string')
      expect(def.function.name.length).toBeGreaterThan(0)
    }
  })
})
