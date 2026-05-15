import fs from 'fs'
import type { ToolModule } from '../types.js'

export const readFileTool: ToolModule = {
  definition: {
    name: 'read_file',
    description: 'Read the contents of a file from the filesystem',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the file' },
      },
      required: ['path'],
    },
  },
  execute: async (args) => {
    const { path } = args
    try {
      const content = fs.readFileSync(path as string, 'utf-8')
      return content
    } catch (err: any) {
      return `Error reading file: ${err.message}`
    }
  },
}
