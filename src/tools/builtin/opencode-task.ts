import type { ToolModule } from '../types.js'
import { runOpencodeTask } from '../../opencode.js'

export const opencodeTaskTool: ToolModule = {
  definition: {
    name: 'opencode_task',
    description: 'Delegate a complex coding or file operation task to OpenCode. Use this for: writing multi-file projects, code generation, refactoring, debugging, or any task that needs an AI coding agent.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task description for OpenCode' },
        model: { type: 'string', description: 'Ollama model to use (default: from config)' },
      },
      required: ['task'],
    },
  },
  execute: async (args) => {
    const { task } = args
    const model = (args.model as string) || process.env.LOCALCLAW_MODEL || 'ollama/llama3.2:3b'
    try {
      const result = await runOpencodeTask(task as string, model)
      return result || '(OpenCode completed with no output)'
    } catch (err: any) {
      return `OpenCode task failed: ${err.message}`
    }
  },
}
