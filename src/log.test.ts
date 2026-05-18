import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('log', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs nothing when level is set to "error" and debug is called', async () => {
    process.env.LOCALCLAW_LOG_LEVEL = 'error'
    const { log } = await import('./log.js')
    log.debug('should not appear')
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('logs nothing when level is "error" and info is called', async () => {
    process.env.LOCALCLAW_LOG_LEVEL = 'error'
    const { log } = await import('./log.js')
    log.info('should not appear')
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('logs nothing when level is "warn" and info is called', async () => {
    process.env.LOCALCLAW_LOG_LEVEL = 'warn'
    const { log } = await import('./log.js')
    log.info('should not appear')
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('logs error when level is "error"', async () => {
    process.env.LOCALCLAW_LOG_LEVEL = 'error'
    const { log } = await import('./log.js')
    log.error('something broke')
    expect(consoleSpy).toHaveBeenCalled()
  })

  it('logs info when level is "info"', async () => {
    process.env.LOCALCLAW_LOG_LEVEL = 'info'
    const { log } = await import('./log.js')
    log.info('hello')
    expect(consoleSpy).toHaveBeenCalled()
  })

  it('logs debug when level is "debug"', async () => {
    process.env.LOCALCLAW_LOG_LEVEL = 'debug'
    const { log } = await import('./log.js')
    log.debug('verbose')
    expect(consoleSpy).toHaveBeenCalled()
  })

  it('logs agent when level is "info"', async () => {
    process.env.LOCALCLAW_LOG_LEVEL = 'info'
    const { log } = await import('./log.js')
    log.agent('agent message')
    expect(consoleSpy).toHaveBeenCalled()
  })

  it('does not log sse when level is "info"', async () => {
    process.env.LOCALCLAW_LOG_LEVEL = 'info'
    const { log } = await import('./log.js')
    log.sse('sse message')
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('logs sse when level is "debug"', async () => {
    process.env.LOCALCLAW_LOG_LEVEL = 'debug'
    const { log } = await import('./log.js')
    log.sse('sse message')
    expect(consoleSpy).toHaveBeenCalled()
  })

  it('logs api when level is "info"', async () => {
    process.env.LOCALCLAW_LOG_LEVEL = 'info'
    const { log } = await import('./log.js')
    log.api('GET', '/test', 200, 42)
    expect(consoleSpy).toHaveBeenCalled()
  })

  it('defaults to "info" when no level is set', async () => {
    delete process.env.LOCALCLAW_LOG_LEVEL
    const { log } = await import('./log.js')
    log.info('default level')
    expect(consoleSpy).toHaveBeenCalled()
  })
})
