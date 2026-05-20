import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSpawn = vi.fn()

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}))

function makeMockSpawn(exitCode = 0, output = 'result') {
  mockSpawn.mockReturnValue({
    stdout: { on: vi.fn((e: string, cb: (d: string) => void) => { if (e === 'data') setImmediate(() => cb(output)) }) },
    stderr: { on: vi.fn() },
    on: vi.fn((e: string, cb: (...args: any[]) => void) => { if (e === 'close') setImmediate(() => cb(exitCode)) }),
  })
}

describe('runOpencodeTask', () => {
  beforeEach(() => {
    vi.resetModules()
    mockSpawn.mockReset()
    makeMockSpawn()
  })

  it('spawns opencode with correct args and no key', async () => {
    delete process.env.LOCALCLAW_OPENCODE_API_KEY
    process.env.LOCALCLAW_OLLAMA_URL = 'http://localhost:11434'
    const { runOpencodeTask } = await import('../src/opencode.js')
    await runOpencodeTask('write a test', 'ollama/qwen2.5:3b')
    expect(mockSpawn).toHaveBeenCalledWith(
      'opencode',
      ['run', '--model', 'ollama/qwen2.5:3b', 'write a test'],
      expect.objectContaining({
        env: expect.objectContaining({
          OPENCODE_DISABLE_AUTOUPDATE: '1',
          OPENCODE_CONFIG_CONTENT: expect.any(String),
        }),
      }),
    )
  })

  it('passes ANTHROPIC_API_KEY env when LOCALCLAW_OPENCODE_API_KEY is set', async () => {
    process.env.LOCALCLAW_OPENCODE_API_KEY = 'sk-ant-test123'
    process.env.LOCALCLAW_OLLAMA_URL = 'http://localhost:11434'
    const { runOpencodeTask } = await import('../src/opencode.js')
    await runOpencodeTask('test', 'ollama/qwen2.5:3b')
    const env = mockSpawn.mock.calls[0][2].env
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test123')
  })

  it('does not include ANTHROPIC_API_KEY when no key is set', async () => {
    delete process.env.LOCALCLAW_OPENCODE_API_KEY
    process.env.LOCALCLAW_OLLAMA_URL = 'http://localhost:11434'
    const { runOpencodeTask } = await import('../src/opencode.js')
    await runOpencodeTask('test', 'ollama/qwen2.5:3b')
    const env = mockSpawn.mock.calls[0][2].env
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
  })

  it('embeds OLLAMA_BASE in config JSON', async () => {
    delete process.env.LOCALCLAW_OPENCODE_API_KEY
    process.env.LOCALCLAW_OLLAMA_URL = 'http://custom:11434'
    const { runOpencodeTask } = await import('../src/opencode.js')
    await runOpencodeTask('test', 'ollama/qwen2.5:3b')
    const env = mockSpawn.mock.calls[0][2].env
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
    expect(config.provider.ollama.options.baseURL).toBe('http://custom:11434/v1')
  })

  it('includes sessionId in args when provided', async () => {
    delete process.env.LOCALCLAW_OPENCODE_API_KEY
    process.env.LOCALCLAW_OLLAMA_URL = 'http://localhost:11434'
    const { runOpencodeTask } = await import('../src/opencode.js')
    await runOpencodeTask('test', 'ollama/qwen2.5:3b', 'session-123')
    expect(mockSpawn).toHaveBeenCalledWith(
      'opencode',
      ['run', '--model', 'ollama/qwen2.5:3b', '--session', 'session-123', 'test'],
      expect.any(Object),
    )
  })

  it('resolves with stdout on success', async () => {
    delete process.env.LOCALCLAW_OPENCODE_API_KEY
    process.env.LOCALCLAW_OLLAMA_URL = 'http://localhost:11434'
    makeMockSpawn(0, 'task completed')
    const { runOpencodeTask } = await import('../src/opencode.js')
    const result = await runOpencodeTask('test', 'ollama/qwen2.5:3b')
    expect(result).toBe('task completed')
  })

  it('rejects when process exits with non-zero and no stdout', async () => {
    delete process.env.LOCALCLAW_OPENCODE_API_KEY
    process.env.LOCALCLAW_OLLAMA_URL = 'http://localhost:11434'
    makeMockSpawn(1, '')
    const { runOpencodeTask } = await import('../src/opencode.js')
    await expect(runOpencodeTask('test', 'ollama/qwen2.5:3b')).rejects.toThrow('opencode exited with code 1')
  })

  it('falls back to stdout when both stdout and stderr are non-empty on non-zero exit', async () => {
    delete process.env.LOCALCLAW_OPENCODE_API_KEY
    process.env.LOCALCLAW_OLLAMA_URL = 'http://localhost:11434'
    mockSpawn.mockReturnValue({
      stdout: { on: vi.fn((e: string, cb: (d: string) => void) => { if (e === 'data') setImmediate(() => cb('partial output')) }) },
      stderr: { on: vi.fn((e: string, cb: (d: string) => void) => { if (e === 'data') setImmediate(() => cb('error detail')) }) },
      on: vi.fn((e: string, cb: (code: number) => void) => { if (e === 'close') setImmediate(() => cb(1)) }),
    })
    const { runOpencodeTask } = await import('../src/opencode.js')
    const result = await runOpencodeTask('test', 'ollama/qwen2.5:3b')
    expect(result).toBe('partial output')
  })
})
