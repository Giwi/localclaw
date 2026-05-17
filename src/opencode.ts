import { spawn } from 'child_process'

const OPENCODE_BIN = process.env.LOCALCLAW_OPENCODE_BIN || 'opencode'
const OPENCODE_API_KEY = process.env.LOCALCLAW_OPENCODE_API_KEY
const OLLAMA_BASE = process.env.LOCALCLAW_OLLAMA_URL || 'http://localhost:11434'

const OPENCODE_CONFIG = JSON.stringify({
  provider: {
    ollama: {
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: `${OLLAMA_BASE}/v1` },
      models: { 'llama3.2:3b': { name: 'Llama 3.2 3B' } },
    },
  },
})

export async function runOpencodeTask(
  input: string,
  model: string,
  sessionId?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['run', '--model', model]

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

    proc.on('close', (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(`opencode exited with code ${code}: ${stderr}`))
      } else {
        resolve(stdout.trim() || stderr.trim())
      }
    })

    proc.on('error', () => {
      reject(new Error('Failed to start opencode. Is it installed?'))
    })
  })
}
