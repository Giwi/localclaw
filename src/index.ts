import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import http from 'http'
import https from 'https'
import { openDb } from './db.js'
import { createRouter } from './api.js'
import { createWebSocket } from './ws.js'
import { authMiddleware } from './auth.js'
import { Agent } from './agent.js'
import { BackgroundScheduler } from './scheduler.js'
import { createScheduleTool } from './tools/builtin/schedule-task.js'
import { createSearchKnowledgeTool } from './tools/builtin/search-knowledge.js'
import { loadPlugins } from './plugins.js'
import chalk from 'chalk'
import { log } from './log.js'

const PORT = parseInt(process.env.LOCALCLAW_PORT || '4173', 10)
const DATA_DIR = process.env.LOCALCLAW_DATA_DIR || path.join(process.env.HOME || '/tmp', '.localclaw')
const CLIENT_DIR = path.resolve(import.meta.dirname, '..', 'client', 'dist', 'client', 'browser')
const OLLAMA_URL = process.env.LOCALCLAW_OLLAMA_URL || 'http://localhost:11434'
const MODEL = process.env.LOCALCLAW_MODEL || 'ollama/llama3.2:3b'

fs.mkdirSync(path.join(DATA_DIR, 'downloads'), { recursive: true })

const db = openDb(DATA_DIR)
const agent = new Agent(DATA_DIR, db)

// Register the schedule_task tool and start background scheduler
const registry = agent.getToolRegistry()
const scheduler = new BackgroundScheduler(db, registry)
registry.register('schedule_task', createScheduleTool(db))
registry.register('search_knowledge', createSearchKnowledgeTool(db))
scheduler.start()

// Startup health checks
log.info('Running startup health checks...')
let healthy = true

try {
  const ollamaRes = await fetch(`${OLLAMA_URL}/api/tags`)
  if (!ollamaRes.ok) {
    log.warn(`Ollama at ${OLLAMA_URL} returned status ${ollamaRes.status}`)
    healthy = false
  } else {
    const tags = await ollamaRes.json()
    const models = (tags.models || []).map((m: any) => m.name)
    log.info(`Ollama: ${OLLAMA_URL} (${models.length} models: ${models.join(', ') || 'none'})`)
  }
} catch (err: any) {
  log.warn(`Ollama not reachable at ${OLLAMA_URL}: ${err.message}`)
  healthy = false
}

const embedModel = process.env.LOCALCLAW_EMBEDDING_MODEL || 'nomic-embed-text'
try {
  const embRes = await fetch(`${OLLAMA_URL}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: embedModel }),
  })
  if (!embRes.ok) {
    log.warn(`Embedding model "${embedModel}" not found in Ollama (run: ollama pull ${embedModel})`)
  } else {
    log.info(`Embedding model "${embedModel}" available`)
  }
} catch { /* skip */ }

if (healthy) log.info('All startup checks passed')
else log.warn('Some startup checks failed — server will start but some features may not work')

const app = express()

const httpsKeyPath = process.env.LOCALCLAW_HTTPS_KEY
const httpsCertPath = process.env.LOCALCLAW_HTTPS_CERT
let server: http.Server | https.Server
if (httpsKeyPath && httpsCertPath && fs.existsSync(httpsKeyPath) && fs.existsSync(httpsCertPath)) {
  server = https.createServer({
    key: fs.readFileSync(httpsKeyPath),
    cert: fs.readFileSync(httpsCertPath),
  }, app)
  log.info(`HTTPS enabled (key=${httpsKeyPath}, cert=${httpsCertPath})`)
} else {
  server = http.createServer(app)
}

app.use(cors())
app.use(express.json())
app.use('/api', authMiddleware, createRouter(db, agent))

// WebSocket for real-time chat
createWebSocket(server, db, agent)

// Load plugins
await loadPlugins(registry, DATA_DIR)

app.use('/downloads', express.static(path.join(DATA_DIR, 'downloads')))
app.use(express.static(CLIENT_DIR))
app.get('*', (_req, res) => {
  res.sendFile(path.join(CLIENT_DIR, 'index.html'))
})

const proto = server instanceof https.Server ? 'https' : 'http'
server.listen(PORT, () => {
  console.log(chalk.cyan(`\n  ╔══════════════════════════════════════════╗`))
  console.log(chalk.cyan(`  ║          localclaw v0.1.0               ║`))
  console.log(chalk.cyan(`  ║   autonomous agent · ollama + opencode  ║`))
  console.log(chalk.cyan(`  ╚══════════════════════════════════════════╝`))
  console.log()
  console.log(chalk.green(`  API:    ${proto}://localhost:${PORT}/api`))
  console.log(chalk.green(`  Web UI: ${proto}://localhost:${PORT}`))
  console.log(chalk.dim(`  Data:   ${DATA_DIR}`))
  console.log(chalk.dim(`  Model:  ${MODEL}`))
  console.log(chalk.dim(`  Tools:  ${agent.getTools().map((t) => t.name).join(', ')}`))
  if (process.env.LOCALCLAW_API_KEY) {
    console.log(chalk.dim(`  Auth:   API key required (Bearer token)`))
  }
  console.log()
  log.info(`Server started on port ${PORT}`)
  log.info(`Data directory: ${DATA_DIR}`)
  log.info(`Ollama: ${OLLAMA_URL}`)
  log.info(`Model: ${MODEL}`)
  const tools = agent.getTools().map((t) => t.name).join(', ')
  log.info(`Tools registered: ${tools}`)
  if (process.env.LOCALCLAW_SEARXNG_URL) {
    log.info(`SearXNG: ${process.env.LOCALCLAW_SEARXNG_URL}`)
  } else {
    log.info('SearXNG: not configured, using DuckDuckGo fallback')
  }
})

function shutdown(signal: string) {
  log.info(`Received ${signal}, shutting down gracefully...`)
  scheduler.stop()
  server.close(() => {
    db.close()
    log.info('Shutdown complete')
    process.exit(0)
  })
  setTimeout(() => {
    log.warn('Forced shutdown after timeout')
    process.exit(1)
  }, 5000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
