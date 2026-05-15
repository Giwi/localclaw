import fs from 'fs'
import path from 'path'
import type { ToolModule } from '../types.js'

export const writeFileTool: ToolModule = {
  definition: {
    name: 'write_file',
    description: 'Write content to a file on the filesystem. Creates parent directories if needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the file' },
        content: { type: 'string', description: 'The content to write' },
      },
      required: ['path', 'content'],
    },
  },
  execute: async (args) => {
    const { path: filePath, content } = args
    try {
      fs.mkdirSync(path.dirname(filePath as string), { recursive: true })
      fs.writeFileSync(filePath as string, content as string, 'utf-8')
      return `File written: ${filePath} (${(content as string).length} bytes)`
    } catch (err: any) {
      return `Error writing file: ${err.message}`
    }
  },
}
