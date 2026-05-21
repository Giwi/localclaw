interface OllamaChatRequest {
  model: string
  messages: { role: string; content: string }[]
  stream: boolean
  options?: { num_ctx?: number }
}
interface OllamaChatResponse {
  model: string
  created_at: string
  message: { role: string; content: string }
  done: boolean
}

const OLLAMA_BASE = process.env.LOCALCLAW_OLLAMA_URL || 'http://localhost:11434'

export async function* streamChat(
  model: string,
  messages: { role: string; content: string }[]
): AsyncGenerator<string> {
  const body: OllamaChatRequest = {
    model: model.replace(/^ollama\//, ''),
    messages,
    stream: true,
    options: { num_ctx: 8192 },
  }

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    throw new Error(`Ollama API error: ${res.status} ${res.statusText}`)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const data: OllamaChatResponse = JSON.parse(line)
        if (data.message?.content) {
          yield data.message.content
        }
      } catch {
        // skip malformed lines
      }
    }
  }
}

export async function chatOnce(
  model: string,
  messages: { role: string; content: string }[]
): Promise<string> {
  const body: OllamaChatRequest = {
    model: model.replace(/^ollama\//, ''),
    messages,
    stream: false,
    options: { num_ctx: 8192 },
  }

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    throw new Error(`Ollama API error: ${res.status} ${res.statusText}`)
  }

  const data: OllamaChatResponse = await res.json().catch(() => {
    throw new Error(`Ollama API returned invalid JSON`)
  })
  return data.message?.content || ''
}
