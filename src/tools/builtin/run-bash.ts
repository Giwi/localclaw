import { execSync } from 'child_process'
import type { ExecSyncOptions } from 'child_process'
import type { ToolModule } from '../types.js'
import { wrapCommand, isSandboxAvailable } from '../sandbox.js'

const EXEC_OPTS: ExecSyncOptions = { encoding: 'utf-8', timeout: 60000, maxBuffer: 10 * 1024 * 1024, shell: '/bin/bash' }

export const runBashTool: ToolModule = {
  definition: {
    name: 'run_bash',
    description: 'Execute a bash command and return its output. Use this for running scripts, git commands, or any shell operations.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: { type: 'string', description: 'Timeout in seconds (default: 30)' },
      },
      required: ['command'],
    },
  },
  execute: async (args) => {
    const command = (args.command || args.cmd || args.script || '') as string
    if (!command.trim()) {
      const dir = (args.directory || args.dir || '.') as string
      const fallback = isSandboxAvailable() ? wrapCommand(`ls -la ${dir}`) : `ls -la ${dir}`
      try {
        const output = (execSync(fallback, EXEC_OPTS) as string).trim()
        return `(no command specified, ran "ls -la ${dir}" as default)\n${output}`
      } catch {
        return 'Please specify a "command" parameter with the bash command to run.'
      }
    }

    const cmd = isSandboxAvailable() ? wrapCommand(command) : command
    try {
      const output = (execSync(cmd, EXEC_OPTS) as string).trim()
      return output || '(command completed with no output)'
    } catch (err: any) {
      return `Command failed: ${err.message}`
    }
  },
}
