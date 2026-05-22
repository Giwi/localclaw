import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

function createMocks(path = '/api/chat', authHeader?: string) {
  const req = {
    path,
    originalUrl: path,
    headers: authHeader ? { authorization: authHeader } : {},
    method: 'GET',
  } as any
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as any
  const next = vi.fn()
  return { req, res, next }
}

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.LOCALCLAW_API_KEY
  })

  it('skips auth when no API key configured', async () => {
    delete process.env.LOCALCLAW_API_KEY
    const { authMiddleware } = await import('../src/auth.js')
    const { req, res, next } = createMocks()
    authMiddleware(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('skips health endpoint', async () => {
    process.env.LOCALCLAW_API_KEY = 'secret123'
    const { authMiddleware } = await import('../src/auth.js')
    const { req, res, next } = createMocks('/health')
    authMiddleware(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('returns 401 when API key is set and no auth header', async () => {
    process.env.LOCALCLAW_API_KEY = 'secret123'
    const { authMiddleware } = await import('../src/auth.js')
    const { req, res, next } = createMocks('/api/chat')
    authMiddleware(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' })
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 401 with wrong Bearer token', async () => {
    process.env.LOCALCLAW_API_KEY = 'secret123'
    const { authMiddleware } = await import('../src/auth.js')
    const { req, res, next } = createMocks('/api/chat', 'Bearer wrongkey')
    authMiddleware(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('passes through with correct Bearer token', async () => {
    process.env.LOCALCLAW_API_KEY = 'secret123'
    const { authMiddleware } = await import('../src/auth.js')
    const { req, res, next } = createMocks('/api/chat', 'Bearer secret123')
    authMiddleware(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('rejects non-Bearer auth header', async () => {
    process.env.LOCALCLAW_API_KEY = 'secret123'
    const { authMiddleware } = await import('../src/auth.js')
    const { req, res, next } = createMocks('/api/chat', 'Basic dXNlcjpwYXNz')
    authMiddleware(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects empty Bearer token', async () => {
    process.env.LOCALCLAW_API_KEY = 'secret123'
    const { authMiddleware } = await import('../src/auth.js')
    const { req, res, next } = createMocks('/api/chat', 'Bearer ')
    authMiddleware(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
})
