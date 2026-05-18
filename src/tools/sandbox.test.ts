import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('wrapCommand', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns command unchanged when sandbox is disabled', async () => {
    process.env.LOCALCLAW_SANDBOX_ENABLED = 'false'
    const { wrapCommand } = await import('./sandbox.js')
    expect(wrapCommand('echo hello')).toBe('echo hello')
  })

  it('returns command unchanged when sandbox env is unset', async () => {
    delete process.env.LOCALCLAW_SANDBOX_ENABLED
    const { wrapCommand } = await import('./sandbox.js')
    expect(wrapCommand('ls -la')).toBe('ls -la')
  })

  it('wraps command in docker when sandbox is enabled', async () => {
    process.env.LOCALCLAW_SANDBOX_ENABLED = 'true'
    process.env.LOCALCLAW_SANDBOX_IMAGE = 'ubuntu:22.04'
    const { wrapCommand } = await import('./sandbox.js')
    const result = wrapCommand('echo hello', '/workspace')
    expect(result).toContain('docker run --rm')
    expect(result).toContain('--network none')
    expect(result).toContain('--security-opt no-new-privileges --cap-drop ALL')
    expect(result).toContain('-v "/workspace:/workspace:ro"')
    expect(result).toContain('-w /workspace')
    expect(result).toContain('ubuntu:22.04')
    expect(result).toContain('bash -c "echo hello"')
  })

  it('escapes double quotes in command', async () => {
    process.env.LOCALCLAW_SANDBOX_ENABLED = 'true'
    process.env.LOCALCLAW_SANDBOX_IMAGE = 'ubuntu:22.04'
    const { wrapCommand } = await import('./sandbox.js')
    const result = wrapCommand('echo "hello world"', '/tmp')
    expect(result).toContain('bash -c "echo \\"hello world\\""')
  })

  it('uses process.cwd() when cwd is not provided', async () => {
    process.env.LOCALCLAW_SANDBOX_ENABLED = 'true'
    process.env.LOCALCLAW_SANDBOX_IMAGE = 'alpine:latest'
    const { wrapCommand } = await import('./sandbox.js')
    const result = wrapCommand('pwd')
    expect(result).toContain(`-v "${process.cwd()}:/workspace:ro"`)
    expect(result).toContain('alpine:latest')
  })

  it('uses custom SANDBOX_IMAGE when configured', async () => {
    process.env.LOCALCLAW_SANDBOX_ENABLED = 'true'
    process.env.LOCALCLAW_SANDBOX_IMAGE = 'custom-image:v1'
    const { wrapCommand } = await import('./sandbox.js')
    const result = wrapCommand('test', '/dir')
    expect(result).toContain('custom-image:v1')
  })
})

describe('isSandboxAvailable', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns false when sandbox is disabled', async () => {
    process.env.LOCALCLAW_SANDBOX_ENABLED = 'false'
    const { isSandboxAvailable } = await import('./sandbox.js')
    expect(isSandboxAvailable()).toBe(false)
  })

  it('returns false when sandbox env is unset', async () => {
    delete process.env.LOCALCLAW_SANDBOX_ENABLED
    const { isSandboxAvailable } = await import('./sandbox.js')
    expect(isSandboxAvailable()).toBe(false)
  })
})
