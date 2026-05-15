import express from 'express'
import cors from 'cors'
import path from 'path'
import { openDb } from './db.js'
import { createRouter } from './api.js'
import { Agent } from './agent.js'
import chalk from 'chalk'
import { log } from './log.js'

const PORT = parseInt(process.env.LOCALCLAW_PORT || '4173', 10)
const DATA_DIR = process.env.LOCALCLAW_DATA_DIR || path.join(process.env.HOME || '/tmp', '.localclaw')
const CLIENT_DIR = path.resolve(import.meta.dirname, '..', 'client', 'dist', 'client', 'browser')

import fs from 'fs'
fs.mkdirSync(path.join(DATA_DIR, 'downloads'), { recursive: true })

const db = openDb(DATA_DIR)
const agent = new Agent(DATA_DIR, db)
const app = express()

app.use(cors())
app.use(express.json())
app.use('/api', createRouter(db, agent))

app.use('/downloads', express.static(path.join(DATA_DIR, 'downloads')))
app.use(express.static(CLIENT_DIR))
app.get('*', (_req, res) => {
  res.sendFile(path.join(CLIENT_DIR, 'index.html'))
})

app.listen(PORT, () => {
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
