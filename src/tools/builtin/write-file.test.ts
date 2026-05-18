import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'
import fs from 'fs'
import os from 'os'

const cwd = process.cwd()

describe('writeFileTool', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('rejects path traversal to /etc/shadow', async () => {
    const { writeFileTool } = await import('./write-file.js')
    const result = await writeFileTool.execute({ path: '/etc/shadow', content: 'hacked' })
    expect(result).toMatch(/path traversal denied/i)
  })

  it('rejects relative path traversal', async () => {
    const { writeFileTool } = await import('./write-file.js')
    const result = await writeFileTool.execute({ path: '../../etc/crontab', content: 'hack' })
    expect(result).toMatch(/path traversal denied/i)
  })

  it('writes file within allowed directory', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localclaw-test-'))
    const testFile = path.join(tmpDir, 'test.txt')

    try {
      process.env.LOCALCLAW_DATA_DIR = tmpDir
      vi.resetModules()
      const { writeFileTool } = await import('./write-file.js')
      const result = await writeFileTool.execute({ path: testFile, content: 'hello world' })
      expect(result).toMatch(/file written/i)
      expect(result).toContain('11 bytes')
      expect(fs.readFileSync(testFile, 'utf-8')).toBe('hello world')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('creates parent directories when writing', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localclaw-test-'))
    const nestedFile = path.join(tmpDir, 'sub', 'nested', 'file.txt')

    try {
      process.env.LOCALCLAW_DATA_DIR = tmpDir
      vi.resetModules()
      const { writeFileTool } = await import('./write-file.js')
      const result = await writeFileTool.execute({ path: nestedFile, content: 'nested' })
      expect(result).toMatch(/file written/i)
      expect(fs.readFileSync(nestedFile, 'utf-8')).toBe('nested')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('writes relative path within allowed dir', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localclaw-test-'))
    try {
      process.env.LOCALCLAW_DATA_DIR = tmpDir
      vi.resetModules()
      const { writeFileTool } = await import('./write-file.js')
      const result = await writeFileTool.execute({ path: path.join(tmpDir, 'rel.txt'), content: 'data' })
      expect(result).toMatch(/file written/i)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
