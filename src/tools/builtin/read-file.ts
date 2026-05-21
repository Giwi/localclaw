import fs from 'fs'
import path from 'path'
import type { ToolModule } from '../types.js'

const ALLOWED_PREFIXES = [
  process.cwd(),
  process.env.LOCALCLAW_DATA_DIR || path.join(process.env.HOME || '/tmp', '.localclaw'),
].map((p) => path.resolve(p))

function isPathSafe(target: string): boolean {
  const resolved = path.resolve(target)
  return ALLOWED_PREFIXES.some((prefix) => resolved.startsWith(prefix))
}

export const readFileTool: ToolModule = {
  definition: {
    name: 'read_file',
    description: 'Read the contents of a file from the filesystem (restricted to project and data directories)',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file (relative or absolute, within project or data dir)' },
      },
      required: ['path'],
    },
  },
  execute: async (args) => {
    const p = args.path as string
    if (!isPathSafe(p)) {
      return `Error: Path traversal denied — "${p}" resolves outside allowed directories`
    }
    try {
      const content = fs.readFileSync(path.resolve(p), 'utf-8')
      return content
    } catch (err: unknown) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}
