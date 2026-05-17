import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import http from 'http'
import { openDb } from './db.js'
import { createRouter } from './api.js'
import { createWebSocket } from './ws.js'
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

fs.mkdirSync(path.join(DATA_DIR, 'downloads'), { recursive: true })

const db = openDb(DATA_DIR)
const agent = new Agent(DATA_DIR, db)

// Register the schedule_task tool and start background scheduler
const registry = agent.getToolRegistry()
const scheduler = new BackgroundScheduler(db, registry)
registry.register('schedule_task', createScheduleTool(db))
registry.register('search_knowledge', createSearchKnowledgeTool(db))
scheduler.start()

const app = express()
const server = http.createServer(app)

app.use(cors())
app.use(express.json())
app.use('/api', createRouter(db, agent))

// WebSocket for real-time chat
createWebSocket(server, db, agent)

// Load plugins
await loadPlugins(registry, DATA_DIR)

app.use('/downloads', express.static(path.join(DATA_DIR, 'downloads')))
app.use(express.static(CLIENT_DIR))
app.get('*', (_req, res) => {
  res.sendFile(path.join(CLIENT_DIR, 'index.html'))
})

server.listen(PORT, () => {
  console.log(chalk.cyan(`\n  ╔══════════════════════════════════════════╗`))
  console.log(chalk.cyan(`  ║          localclaw v0.1.0               ║`))
  console.log(chalk.cyan(`  ║   autonomous agent · ollama + opencode  ║`))
  console.log(chalk.cyan(`  ╚══════════════════════════════════════════╝`))
  console.log()
  console.log(chalk.green(`  API:    http://localhost:${PORT}/api`))
  console.log(chalk.green(`  Web UI: http://localhost:${PORT}`))
  console.log(chalk.dim(`  Data:   ${DATA_DIR}`))
  console.log(chalk.dim(`  Model:  ${process.env.LOCALCLAW_MODEL || 'ollama/llama3.2:3b'}`))
  console.log(chalk.dim(`  Tools:  ${agent.getTools().map((t) => t.name).join(', ')}`))
  console.log()
  log.info(`Server started on port ${PORT}`)
  log.info(`Data directory: ${DATA_DIR}`)
  log.info(`Ollama: ${process.env.LOCALCLAW_OLLAMA_URL || 'http://localhost:11434'}`)
  log.info(`Model: ${process.env.LOCALCLAW_MODEL || 'ollama/llama3.2:3b'}`)
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
