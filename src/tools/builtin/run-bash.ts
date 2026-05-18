import { spawn } from 'child_process'
import type { ToolModule } from '../types.js'
import { wrapCommand, isSandboxAvailable } from '../sandbox.js'

const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+[\/~]\s*$/,
  /\brm\s+-rf\s+[\/~]\b.*\b(?!\/)/,
  /\brm\s+-rf\s+\/\s*$/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\b>:\)/,
  /\b:\(\)\s*\{/,
  /\bchmod\s+-R\s+000\s+\//,
  /\bdestroy\s+--all\b/,
  /\bpasswd\b/,
  /\bwget\s+.*\||\bcurl\s+.*\|/,
  />\s*\/dev\/sda/,
]

function isBlocked(cmd: string): string | null {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      return `Command blocked: pattern "${pattern}" matches a potentially destructive operation.`
    }
  }
  return null
}

export const runBashTool: ToolModule = {
  definition: {
    name: 'run_bash',
    description: 'Execute a bash command and return its output. Use this for running scripts, git commands, or any shell operations.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: { type: 'string', description: 'Timeout in seconds (default: 120)' },
      },
      required: ['command'],
    },
  },
  execute: async (args, onChunk) => {
    const command = (args.command || args.cmd || args.script || '') as string
    const timeoutSec = parseInt((args.timeout || args.timeout_seconds || '120') as string, 10) || 120

    if (!command.trim()) {
      return 'Please specify a "command" parameter with the bash command to run.'
    }

    const blocked = isBlocked(command)
    if (blocked) return blocked

    const cmd = isSandboxAvailable() ? wrapCommand(command) : command

    return new Promise<string>((resolve, reject) => {
      const child = spawn('/bin/bash', ['-c', cmd], {
        timeout: timeoutSec * 1000,
        env: { ...process.env, PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      child.stdout!.on('data', (data: Buffer) => {
        const text = data.toString('utf-8')
        stdout += text
        onChunk?.(text)
      })

      child.stderr!.on('data', (data: Buffer) => {
        const text = data.toString('utf-8')
        stderr += text
        onChunk?.(text)
      })

      child.on('close', (code: number | null) => {
        const output = stdout.trim() || stderr.trim() || '(command completed with no output)'
        if (code === 0 || code === null) {
          resolve(output)
        } else {
          resolve(`Exit code ${code}\n${output}`)
        }
      })

      child.on('error', (err: Error) => {
        reject(new Error(err.message))
      })
    })
  },
}
