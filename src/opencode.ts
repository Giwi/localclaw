/**
 * opencode.ts — Spawn the OpenCode CLI as an external agent
 *
 * OpenCode (https://opencode.ai) is a separate CLI tool that can run tasks
 * using its own model (typically Anthropic Claude via the OPENCODE_API_KEY).
 * We use it in two places:
 *
 *   1. Pre-planning (agent.ts) — before the main Ollama loop starts,
 *      OpenCode analyses the user query and may generate a bash one-liner
 *      tool that directly answers the question.
 *
 *   2. Dynamic tool creation (agent.ts) — when the Ollama model is stuck,
 *      OpenCode is asked to produce a bash command that answers the question
 *      directly.
 *
 * Environment variables:
 *   LOCALCLAW_OPENCODE_BIN   — path to the opencode binary (default: "opencode")
 *   LOCALCLAW_OPENCODE_API_KEY — Anthropic API key for OpenCode's model
 *   LOCALCLAW_OLLAMA_URL    — base URL for the Ollama-compatible model server
 */

import { spawn } from 'child_process'
import { log } from './log.js'

const OPENCODE_BIN = process.env.LOCALCLAW_OPENCODE_BIN || 'opencode'
const OPENCODE_API_KEY = process.env.LOCALCLAW_OPENCODE_API_KEY
const OLLAMA_BASE = process.env.LOCALCLAW_OLLAMA_URL || 'http://localhost:11434'

// Configuration JSON passed to OpenCode via OPENCODE_CONFIG_CONTENT env var.
// Sets up an Ollama-compatible provider so OpenCode can fall back to the local
// model when no API key is provided.
const OPENCODE_CONFIG = JSON.stringify({
  provider: {
    ollama: {
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: `${OLLAMA_BASE}/v1` },
      models: { 'llama3.2:3b': { name: 'Llama 3.2 3B' } },
    },
  },
})

/**
 * Run an OpenCode task and return its stdout.
 *
 * @param input      The task / prompt to send to OpenCode.
 * @param model      (optional) Model override — currently unused.
 * @param sessionId  (optional) OpenCode session ID for conversation context.
 * @returns          The trimmed stdout output from OpenCode.
 */
export async function runOpencodeTask(
  input: string,
  model?: string,
  sessionId?: string
): Promise<string> {
  log.agent(`opencode run  input="${input.slice(0, 140)}..."`)
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const args = ['run']

    if (sessionId) {
      args.push('--session', sessionId)
    }

    args.push(input)

    const proc = spawn(OPENCODE_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_CONFIG_CONTENT: OPENCODE_CONFIG,
        // When an Anthropic key is available, OpenCode will prefer it over
        // the local Ollama model for better reasoning capabilities.
        ...(OPENCODE_API_KEY ? { ANTHROPIC_API_KEY: OPENCODE_API_KEY } : {}),
      },
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code, signal) => {
      const elapsed = Date.now() - t0
      log.agent(`opencode done exit=${code} signal=${signal} chars=${(stdout || stderr).trim().length} duration=${elapsed}ms`)
      if (code !== 0 && code !== null && !stdout) {
        reject(new Error(`opencode exited with code ${code}: ${stderr}`))
      } else if (code === null && !stdout) {
        reject(new Error(`opencode killed by signal ${signal}: ${stderr}`))
      } else {
        resolve(stdout.trim() || stderr.trim())
      }
    })

    proc.on('error', () => {
      const elapsed = Date.now() - t0
      log.agent(`opencode failed to start after ${elapsed}ms`)
      reject(new Error('Failed to start opencode. Is it installed?'))
    })
  })
}