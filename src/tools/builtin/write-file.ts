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

export const writeFileTool: ToolModule = {
  definition: {
    name: 'write_file',
    description: 'Write content to a file on the filesystem. Creates parent directories if needed. (Restricted to project and data directories)',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file (relative or absolute, within project or data dir)' },
        content: { type: 'string', description: 'The content to write' },
      },
      required: ['path', 'content'],
    },
  },
  execute: async (args) => {
    const filePath = args.path as string
    const content = args.content as string
    if (!isPathSafe(filePath)) {
      return `Error: Path traversal denied — "${filePath}" resolves outside allowed directories`
    }
    try {
      const resolved = path.resolve(filePath)
      fs.mkdirSync(path.dirname(resolved), { recursive: true })
      fs.writeFileSync(resolved, content, 'utf-8')
      return `File written: ${filePath} (${content.length} bytes)`
    } catch (err: unknown) {
      return `Error writing file: ${err instanceof Error ? err.message : String(err)}`
    }
  },
}
