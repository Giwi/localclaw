// Response classifiers — used by the agent loop to decide how to handle
// Ollama responses (advisory detection, greetings, success confirmations).

const OLLAMA_BASE = process.env.LOCALCLAW_OLLAMA_URL || 'http://localhost:11434'

export function isSuccessConfirmation(content: string): boolean {
  return /(successfully scheduled|successfully created|task has been|background task|cron task|scheduled task|tâche a été|planifiée avec succès|programmée pour)/i.test(content)
}

export function isGreetingResponse(content: string): boolean {
  return content.trim().length < 120
    && /^(hello|hi\b|hey|salut|bonjour|coucou|hola|yo\b|good (morning|afternoon|evening)|welcome|how (can|may) i (assist|help)|how can i (assist|help)|comment (puis-je|je peux) (vous|t['\u2019])aider|que puis-je faire|what can i (do|help))/i.test(content.trim())
}

export async function classifyQueryComplexity(
  query: string,
  model: string,
  modelId: (raw: string) => string,
): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId(model),
        prompt: `You are a query complexity classifier. Does the user's message require external tools, current data, or complex reasoning to answer? Answer ONLY "SIMPLE" (greetings, small talk, basic questions) or "COMPLEX" (requires tools, research, code, files, web search, calculations, scheduling).\n\nQuery: "${query.slice(0, 200)}"`,
        stream: false,
        options: { num_predict: 10, temperature: 0 },
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return false
    const data = await res.json()
    return (data.response || '').toUpperCase().includes('SIMPLE')
  } catch {
    return false
  }
}

export async function classifyAdvisory(
  content: string,
  model: string,
  modelId: (raw: string) => string,
): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId(model),
        prompt: `Does the following AI response ADVISORY or ANSWER?\n\n"${content.slice(0, 800)}"\n\nReply ONLY with the single word ADVISORY or ANSWER.`,
        stream: false,
        options: { num_ctx: 2048 },
      }),
      signal: AbortSignal.timeout(8_000),
    })
    if (res.ok) {
      const data = await res.json()
      const word = (data.response || '').trim().toUpperCase().replace(/[^A-Z]/g, '')
      if (word === 'ADVISORY') return true
      if (word === 'ANSWER') return false
    }
  } catch { /* fall through to regex */ }
  // Regex fallback
  return /(i suggest|try using|you need to|you should|i will|i'll|let me|going to|can you|could you|please provide|je suggère|essayez d'utiliser|vous devez|je vais|laissez-moi|je propose|je peux vous|je pourrais|voici quelques|ressources|vous pouvez consulter|tu peux trouver|here are some)/i.test(content)
}
