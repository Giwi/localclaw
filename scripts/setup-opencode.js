#!/usr/bin/env node

import fs from 'fs'
import path from 'path'

const OPENCODE_CONFIG_DIR = path.join(process.env.HOME || '/tmp', '.config', 'opencode')
const OPENCODE_CONFIG_PATH = path.join(OPENCODE_CONFIG_DIR, 'opencode.json')
const OLLAMA_URL = process.env.LOCALCLAW_OLLAMA_URL || 'http://localhost:11434'
const OPENCODE_API_KEY = process.env.LOCALCLAW_OPENCODE_API_KEY

const ollamaProvider = {
  ollama: {
    npm: '@ai-sdk/openai-compatible',
    name: 'Ollama (local)',
    options: {
      baseURL: `${OLLAMA_URL}/v1`,
    },
  },
}

let config = {}

if (fs.existsSync(OPENCODE_CONFIG_PATH)) {
  config = JSON.parse(fs.readFileSync(OPENCODE_CONFIG_PATH, 'utf-8'))
}

if (!config.provider) {
  config.provider = {}
}

config.provider = { ...ollamaProvider, ...config.provider }

if (OPENCODE_API_KEY && !config.provider.anthropic) {
  config.provider.anthropic = {
    npm: '@ai-sdk/anthropic',
    name: 'Anthropic (cloud)',
    apiKey: OPENCODE_API_KEY,
  }
}

if (!config.agent) {
  config.agent = {}
}
if (!config.agent.coder) {
  config.agent.coder = {}
}
if (!config.agent.coder.model) {
  config.agent.coder.model = OPENCODE_API_KEY
    ? 'anthropic/claude-sonnet-4-20250514'
    : 'ollama/llama3.2:3b'
}

fs.mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true })
fs.writeFileSync(OPENCODE_CONFIG_PATH, JSON.stringify(config, null, 2))

console.log(`OpenCode configured at:`)
console.log(`  ${OPENCODE_CONFIG_PATH}`)
console.log(`  Ollama endpoint: ${OLLAMA_URL}/v1`)
if (OPENCODE_API_KEY) {
  console.log(`  Anthropic provider: configured (API key found)`)
  console.log(`  Default model: anthropic/claude-sonnet-4-20250514`)
} else {
  console.log(`  Default model: ollama/llama3.2:3b`)
}
console.log()
console.log('Set LOCALCLAW_OPENCODE_API_KEY in .env to enable cloud models (Anthropic Claude).')
console.log('Then use: opencode run --model <provider/model> "your prompt"')
