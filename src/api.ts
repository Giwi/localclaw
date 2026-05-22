import { Router, type Request, type Response } from 'express'
import type Database from 'better-sqlite3'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { execSync } from 'child_process'
import {
  createSession,
  listSessions,
  getSession,
  getMessages,
  addMessage,
  deleteSession,
  updateSessionName,
  deleteMessagesAfter,
  createBackgroundTask,
  listBackgroundTasks,
  getBackgroundTask,
  updateBackgroundTask,
  deleteBackgroundTask,
  getTaskExecutions,
  addKnowledgeDocument,
  addKnowledgeChunk,
  listKnowledgeDocuments,
  deleteKnowledgeDocument,
} from './db.js'
import { embed } from './embeddings.js'
import { Agent } from './agent.js'
import { log } from './log.js'

fs.mkdirSync('/tmp/localclaw_uploads', { recursive: true })
const upload = multer({ dest: '/tmp/localclaw_uploads', limits: { fileSize: 20 * 1024 * 1024 } })

const DEFAULT_MODEL = process.env.LOCALCLAW_MODEL || 'ollama/llama3.2:3b'

export function createRouter(db: Database.Database, agent: Agent): Router {
  const router = Router()

  // Request logging middleware
  router.use((req: Request, res: Response, next) => {
    const start = Date.now()
    res.on('finish', () => {
      log.api(req.method, req.originalUrl, res.statusCode, Date.now() - start)
    })
    next()
  })

  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', model: DEFAULT_MODEL, tools: agent.getTools().map((t) => t.name) })
  })

  router.get('/tools', (_req: Request, res: Response) => {
    res.json(agent.getTools())
  })

  router.get('/sessions', (_req: Request, res: Response) => {
    const sessions = listSessions(db)
    res.json(sessions)
  })

  router.post('/sessions', (req: Request, res: Response) => {
    const { name, model } = req.body || {}
    const session = createSession(db, model || DEFAULT_MODEL, name)
    res.status(201).json(session)
  })

  router.get('/sessions/:id', (req: Request, res: Response) => {
    const session = getSession(db, req.params.id)
    if (!session) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    res.json(session)
  })

  router.delete('/sessions/:id', (req: Request, res: Response) => {
    deleteSession(db, req.params.id)
    res.json({ ok: true })
  })

  router.patch('/sessions/:id', (req: Request, res: Response) => {
    const { name } = req.body || {}
    if (name) {
      updateSessionName(db, req.params.id, name)
    }
    const session = getSession(db, req.params.id)
    res.json(session)
  })

  router.get('/sessions/:id/messages', (req: Request, res: Response) => {
    const messages = getMessages(db, req.params.id)
    res.json(messages)
  })

  router.get('/sessions/:id/proactive', (req: Request, res: Response) => {
    const tasks = listBackgroundTasks(db, req.params.id)
    const enabledTasks = tasks.filter(t => t.enabled)
    if (enabledTasks.length === 0) {
      res.json(null)
      return
    }
    const lines = enabledTasks.map(t => {
      const next = t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : '—'
      return `  • ${t.name} (${t.toolName}) · next: ${next}`
    })
    res.json({
      role: 'assistant',
      content: `👋 I have ${enabledTasks.length} scheduled task${enabledTasks.length > 1 ? 's' : ''} coming up:\n${lines.join('\n')}`,
    })
  })

  router.patch('/sessions/:id/messages/:msgId', (req: Request, res: Response) => {
    const { content } = req.body || {}
    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'content is required' })
      return
    }
    deleteMessagesAfter(db, req.params.id, req.params.msgId)
    const history = getMessages(db, req.params.id)
    res.json(history)
  })

  router.get('/background-tasks', (req: Request, res: Response) => {
    const sessionId = req.query.session_id as string | undefined
    const tasks = listBackgroundTasks(db, sessionId)
    res.json(tasks)
  })

  router.get('/background-tasks/:id', (req: Request, res: Response) => {
    const task = getBackgroundTask(db, req.params.id)
    if (!task) { res.status(404).json({ error: 'Background task not found' }); return }
    res.json(task)
  })

  router.delete('/background-tasks/:id', (req: Request, res: Response) => {
    deleteBackgroundTask(db, req.params.id)
    res.json({ ok: true })
  })

  router.patch('/background-tasks/:id', (req: Request, res: Response) => {
    const { enabled } = req.body || {}
    updateBackgroundTask(db, req.params.id, { enabled: !!enabled })
    const task = getBackgroundTask(db, req.params.id)
    res.json(task)
  })

  // GET /api/background-tasks/:id/logs - get execution history for a task
  router.get('/background-tasks/:id/logs', (req: Request, res: Response) => {
    const task = getBackgroundTask(db, req.params.id)
    if (!task) { res.status(404).json({ error: 'Background task not found' }); return }
    const history = getTaskExecutions(db, req.params.id)
    res.json({ task, history })
  })

  // POST /api/background-tasks/:id/run - manually trigger a task run
  router.post('/background-tasks/:id/run', (req: Request, res: Response) => {
    const task = getBackgroundTask(db, req.params.id)
    if (!task) { res.status(404).json({ error: 'Background task not found' }); return }
    updateBackgroundTask(db, task.id, { nextRunAt: new Date().toISOString() })
    res.json({ ok: true, message: 'Task triggered' })
  })

  router.get('/knowledge', (_req: Request, res: Response) => {
    const docs = listKnowledgeDocuments(db)
    res.json(docs)
  })

  router.delete('/knowledge/:id', (req: Request, res: Response) => {
    deleteKnowledgeDocument(db, req.params.id)
    res.json({ ok: true })
  })

  router.post('/sessions/:id/upload', upload.single('file'), async (req: Request, res: Response) => {
    const file = req.file
    if (!file) {
      res.status(400).json({ error: 'No file uploaded' })
      return
    }
    const ext = path.extname(file.originalname).toLowerCase()
    let text = ''
    try {
      if (ext === '.txt' || ext === '.md') {
        text = fs.readFileSync(file.path, 'utf-8')
      } else if (ext === '.pdf') {
        if (!/^[a-zA-Z0-9_./-]+$/.test(file.path)) throw new Error('Invalid file path')
        const outPath = file.path + '.txt'
        execSync(`pdftotext -layout "${file.path}" "${outPath}"`, { timeout: 30000 })
        text = fs.readFileSync(outPath, 'utf-8')
        try { fs.unlinkSync(outPath) } catch {}
      } else {
        text = `[Uploaded file: ${file.originalname} (${(file.size / 1024).toFixed(1)} KB)]`
      }
    } catch {
      text = `[Uploaded file: ${file.originalname}]`
    } finally {
      try { fs.unlinkSync(file.path) } catch {}
    }
    const msg = addMessage(db, { sessionId: req.params.id, role: 'user', content: text.trim() || `[Uploaded: ${file.originalname}]` })
    res.json(msg)
  })

  router.post('/knowledge/upload', upload.single('file'), async (req: Request, res: Response) => {
    const file = req.file
    if (!file) {
      res.status(400).json({ error: 'No file uploaded. Send a multipart/form-data with a "file" field.' })
      return
    }

    log.info(`Knowledge upload: ${file.originalname} (${(file.size / 1024).toFixed(1)} KB)`)

    const ext = path.extname(file.originalname).toLowerCase()
    let text = ''

    try {
      if (ext === '.txt' || ext === '.md') {
        text = fs.readFileSync(file.path, 'utf-8')
      } else if (ext === '.pdf') {
        if (!/^[a-zA-Z0-9_./-]+$/.test(file.path)) throw new Error('Invalid file path')
        const outPath = file.path + '.txt'
        execSync(`pdftotext -layout "${file.path}" "${outPath}"`, { timeout: 30000 })
        text = fs.readFileSync(outPath, 'utf-8')
        try { fs.unlinkSync(outPath) } catch {}
      } else if (ext === '.docx') {
        if (!/^[a-zA-Z0-9_./-]+$/.test(file.path)) throw new Error('Invalid file path')
        text = execSync(
          `python3 -c "
import sys, json
try:
  from docx import Document
  doc = Document('${file.path.replace(/'/g, "'\\''")}')
  print(json.dumps('\\n'.join(p.text for p in doc.paragraphs)))
except Exception as e:
  print(json.dumps(f'Error: {e}'))
"`,
          { encoding: 'utf-8', timeout: 30000 }
        ).trim()
        text = JSON.parse(text)
      } else {
        res.status(400).json({ error: `Unsupported file type: ${ext}. Supported: .txt, .md, .pdf, .docx` })
        return
      }
    } catch (err: unknown) {
      const errm = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: `Failed to extract text: ${errm}` })
      return
    } finally {
      try { fs.unlinkSync(file.path) } catch {}
    }

    text = text.trim()
    if (!text) {
      res.status(400).json({ error: 'No text could be extracted from the file.' })
      try { fs.unlinkSync(file.path) } catch {}
      return
    }

    // Store document
    const doc = addKnowledgeDocument(db, file.originalname, ext.slice(1), file.size)

    // Chunk text into ~500 char chunks with overlap
    const chunks: string[] = []
    const words = text.split(/\s+/)
    let current = ''
    for (const word of words) {
      if (current.length + word.length > 500 && current.length > 100) {
        chunks.push(current.trim())
        current = word
      } else {
        current += ' ' + word
      }
    }
    if (current.trim()) chunks.push(current.trim())

    // Embed and store each chunk
    let embedded = 0
    for (const chunk of chunks) {
      try {
        const emb = await embed(chunk.slice(0, 1000))
        addKnowledgeChunk(db, doc.id, chunk.slice(0, 2000), emb)
        embedded++
      } catch { /* skip failed chunks */ }
    }

    log.info(`Knowledge: "${file.originalname}" → ${chunks.length} chunks, ${embedded} embedded`)
    res.json({
      ok: true,
      document: doc,
      chunks: chunks.length,
      embedded,
      textLength: text.length,
    })
  })

  return router
}
