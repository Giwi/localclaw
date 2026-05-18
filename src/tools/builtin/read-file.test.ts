import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'

const cwd = process.cwd()

describe('readFileTool', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('rejects path traversal to /etc/passwd', async () => {
    const { readFileTool } = await import('./read-file.js')
    const result = await readFileTool.execute({ path: '/etc/passwd' })
    expect(result).toMatch(/path traversal denied/i)
  })

  it('rejects relative path traversal', async () => {
    const { readFileTool } = await import('./read-file.js')
    const result = await readFileTool.execute({ path: '../../etc/passwd' })
    expect(result).toMatch(/path traversal denied/i)
  })

  it('rejects deeply nested relative traversal', async () => {
    const { readFileTool } = await import('./read-file.js')
    const result = await readFileTool.execute({ path: 'foo/../../../../etc/shadow' })
    expect(result).toMatch(/path traversal denied/i)
  })

  it('allows absolute path within allowed directory', async () => {
    const { readFileTool } = await import('./read-file.js')
    const safePath = path.join(cwd, 'package.json')
    const result = await readFileTool.execute({ path: safePath })
    expect(result).toBeDefined()
    expect(result).not.toMatch(/path traversal denied/i)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('allows relative path within project dir', async () => {
    const { readFileTool } = await import('./read-file.js')
    const result = await readFileTool.execute({ path: 'package.json' })
    expect(result).not.toMatch(/path traversal denied/i)
  })

  it('returns error for non-existent file within allowed dir', async () => {
    const { readFileTool } = await import('./read-file.js')
    const result = await readFileTool.execute({ path: 'nonexistent-file-12345.txt' })
    expect(result).toMatch(/error reading file/i)
  })
})
