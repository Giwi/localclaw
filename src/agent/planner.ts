// AI planning: decompose complex queries into sequential sub-tasks.

const OLLAMA_BASE = process.env.LOCALCLAW_OLLAMA_URL || 'http://localhost:11434'

export interface PlanStep {
  description: string
  toolName: string
  toolArgs: Record<string, unknown>
}

export async function planWithOllama(
  query: string,
  model: string,
  modelId: (raw: string) => string,
  toolList: string,
): Promise<PlanStep[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId(model),
        prompt: `You are a task planner. Decompose the user's request into numbered steps. For each step, specify which tool to use and its arguments.\n\nAvailable tools:\n${toolList}\n\nUser request: "${query.slice(0, 1000)}"\n\nOutput format:\nSTEP N: short description\nTOOL: tool_name(key="value", ...)\n\nRules:\n- Use ONLY tools from the list above\n- If no tool fits, write TOOL: none\n- Keep the plan to 5 steps max\n\nPlan:`,
        stream: false,
        options: { num_ctx: 4096, temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return []
    const text = (await res.json().then(d => d.response) || '').trim()
    if (!text) return []

    const steps: PlanStep[] = []
    const lines = text.split('\n')
    let currentDesc = ''

    for (const line of lines) {
      const stepMatch = line.match(/^STEP\s*\d+:?\s*(.+)/i)
      if (stepMatch) { currentDesc = stepMatch[1].trim(); continue }

      const toolMatch = line.match(/^TOOL:\s*(\w+)\((.+)\)/i)
      if (toolMatch && currentDesc) {
        const toolName = toolMatch[1].trim()
        const rawArgs = toolMatch[2].trim()
        const toolArgs: Record<string, unknown> = {}
        try {
          const pairs = rawArgs.match(/(\w+)\s*=\s*("([^"]*)"|'([^']*)'|([^,]+))/g)
          if (pairs) {
            for (const pair of pairs) {
              const m = pair.match(/(\w+)\s*=\s*("([^"]*)"|'([^']*)'|(.+))/)
              if (m) {
                const val = (m[3] ?? m[4] ?? m[5] ?? '').trim()
                const num = Number(val)
                toolArgs[m[1]] = isNaN(num) || val === '' ? val : num
              }
            }
          }
        } catch { /* keep empty args */ }
        if (toolName.toLowerCase() !== 'none') {
          steps.push({ description: currentDesc, toolName, toolArgs })
        }
        currentDesc = ''
      }
    }
    return steps
  } catch {
    return []
  }
}
