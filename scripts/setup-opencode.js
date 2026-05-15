#!/usr/bin/env node

import fs from 'fs'
import path from 'path'

const OPENCODE_CONFIG_DIR = path.join(process.env.HOME || '/tmp', '.config', 'opencode')
const OPENCODE_CONFIG_PATH = path.join(OPENCODE_CONFIG_DIR, 'opencode.json')
const OLLAMA_URL = process.env.LOCALCLAW_OLLAMA_URL || 'http://localhost:11434'

const ollamaProvider = {
  ollama: {
    npm: '@ai-sdk/openai-compatible',
    name: 'Ollama (local)',
    options: {
      baseURL: `${OLLAMA_URL}/v1`,
    },
  },
}

let config: any = {}

if (fs.existsSync(OPENCODE_CONFIG_PATH)) {
  config = JSON.parse(fs.readFileSync(OPENCODE_CONFIG_PATH, 'utf-8'))
}

if (!config.provider) {
  config.provider = {}
}

config.provider = { ...ollamaProvider, ...config.provider }

if (!config.agent) {
  config.agent = {}
}
if (!config.agent.coder) {
  config.agent.coder = {}
}
if (!config.agent.coder.model) {
  config.agent.coder.model = 'ollama/llama3.2:3b'
}

fs.mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true })
fs.writeFileSync(OPENCODE_CONFIG_PATH, JSON.stringify(config, null, 2))

console.log(`OpenCode configured with Ollama provider at:`)
console.log(`  ${OPENCODE_CONFIG_PATH}`)
console.log(`  Endpoint: ${OLLAMA_URL}/v1`)
console.log()
console.log('Available models can be added under provider.ollama.models in the config.')
console.log('Then use them with: opencode run --model ollama/<model-name> "your prompt"')
