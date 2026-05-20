import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()

beforeEach(() => {
  vi.resetModules()
  mockFetch.mockReset()
})

describe('chatOnce', () => {
  it('sends correct request body and returns message content', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'Hello!' }, done: true }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { chatOnce } = await import('../src/ollama.js')
    const result = await chatOnce('ollama/qwen2.5:3b', [{ role: 'user', content: 'hi' }])

    expect(result).toBe('Hello!')
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"model":"qwen2.5:3b"'),
      }),
    )
  })

  it('strips ollama/ prefix from model name', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'ok' }, done: true }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { chatOnce } = await import('../src/ollama.js')
    await chatOnce('ollama/llama3.2:3b', [])
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.model).toBe('llama3.2:3b')
  })

  it('does not strip model without ollama/ prefix', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'ok' }, done: true }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { chatOnce } = await import('../src/ollama.js')
    await chatOnce('qwen2.5:3b', [])
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.model).toBe('qwen2.5:3b')
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    })
    vi.stubGlobal('fetch', mockFetch)

    const { chatOnce } = await import('../src/ollama.js')
    await expect(chatOnce('test', [])).rejects.toThrow('Ollama API error: 503 Service Unavailable')
  })

  it('returns empty string when message content is missing', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ message: {}, done: true }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { chatOnce } = await import('../src/ollama.js')
    const result = await chatOnce('test', [])
    expect(result).toBe('')
  })

  it('sets num_ctx to 8192', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'ok' }, done: true }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const { chatOnce } = await import('../src/ollama.js')
    await chatOnce('test', [])
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.options.num_ctx).toBe(8192)
    expect(body.stream).toBe(false)
  })
})

describe('streamChat', () => {
  it('yields tokens from NDJSON stream', async () => {
    const mockReader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{"message":{"content":"Hello"}}\n{"message":{"content":" world"}}\n') })
        .mockResolvedValueOnce({ done: true, value: undefined }),
    }
    mockFetch.mockResolvedValue({
      ok: true,
      body: { getReader: () => mockReader },
    })
    vi.stubGlobal('fetch', mockFetch)

    const { streamChat } = await import('../src/ollama.js')
    const tokens: string[] = []
    for await (const token of streamChat('ollama/test', [])) {
      tokens.push(token)
    }
    expect(tokens).toEqual(['Hello', ' world'])
  })

  it('skips malformed JSON lines', async () => {
    const mockReader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('not json\n{"message":{"content":"valid"}}\n') })
        .mockResolvedValueOnce({ done: true, value: undefined }),
    }
    mockFetch.mockResolvedValue({
      ok: true,
      body: { getReader: () => mockReader },
    })
    vi.stubGlobal('fetch', mockFetch)

    const { streamChat } = await import('../src/ollama.js')
    const tokens: string[] = []
    for await (const token of streamChat('test', [])) {
      tokens.push(token)
    }
    expect(tokens).toEqual(['valid'])
  })

  it('handles chunk-boundary splits', async () => {
    const encoder = new TextEncoder()
    const mockReader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: encoder.encode('{"message":{"content":"hel') })
        .mockResolvedValueOnce({ done: false, value: encoder.encode('lo"}}\n') })
        .mockResolvedValueOnce({ done: true, value: undefined }),
    }
    mockFetch.mockResolvedValue({
      ok: true,
      body: { getReader: () => mockReader },
    })
    vi.stubGlobal('fetch', mockFetch)

    const { streamChat } = await import('../src/ollama.js')
    const tokens: string[] = []
    for await (const token of streamChat('test', [])) {
      tokens.push(token)
    }
    expect(tokens).toEqual(['hello'])
  })

  it('skips lines with empty content', async () => {
    const mockReader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{"message":{"content":""}}\n{"message":{"content":"real"}}\n') })
        .mockResolvedValueOnce({ done: true, value: undefined }),
    }
    mockFetch.mockResolvedValue({
      ok: true,
      body: { getReader: () => mockReader },
    })
    vi.stubGlobal('fetch', mockFetch)

    const { streamChat } = await import('../src/ollama.js')
    const tokens: string[] = []
    for await (const token of streamChat('test', [])) {
      tokens.push(token)
    }
    expect(tokens).toEqual(['real'])
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Error',
    })
    vi.stubGlobal('fetch', mockFetch)

    const { streamChat } = await import('../src/ollama.js')
    const generator = streamChat('test', [])
    await expect(generator.next()).rejects.toThrow('Ollama API error: 500 Internal Error')
  })

  it('throws when response body is null', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      body: null,
    })
    vi.stubGlobal('fetch', mockFetch)

    const { streamChat } = await import('../src/ollama.js')
    const generator = streamChat('test', [])
    await expect(generator.next()).rejects.toThrow('No response body')
  })
})
