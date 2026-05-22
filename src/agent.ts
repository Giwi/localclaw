/**
 * agent.ts — Core agent loop
 *
 * The high-level flow for each incoming message:
 *   1. RAG — embed last user message, retrieve relevant memories & knowledge.
 *   2. Context summarization — summarise if > 8000 chars.
 *   3. Pre-planning — OpenCode answers directly on first messages.
 *   4. AI Planning — Ollama decomposes complex queries into sub-tasks.
 *   5. Agent loop — up to 15 iterations of Ollama + tool execution.
 *
 * Prompts, classifiers, planners, and OpenCode bridge are in src/agent/.
 */

import { SYSTEM_PROMPT_HEAD, SYSTEM_PROMPT_TAIL, forceToolMsg, PERSIST_MSG } from './agent/prompts.js'
import { isSuccessConfirmation, isGreetingResponse, classifyQueryComplexity, classifyAdvisory } from './agent/classifier.js'
import { planWithOllama } from './agent/planner.js'
import { solveWithOpencode, askOpencode } from './agent/opencode-bridge.js'
import type BetterSqlite3 from 'better-sqlite3'
import { ToolRegistry } from './tools/registry.js'
import type { AgentEvent } from './tools/types.js'
import { embed } from './embeddings.js'
import { storeMemory, searchMemories, searchKnowledge, addToolCall } from './db.js'
import { log } from './log.js'

const OLLAMA_BASE = process.env.LOCALCLAW_OLLAMA_URL || 'http://localhost:11434'
const TOOL_SEND_EMAIL = 'send_email'
const TOOL_SCHEDULE_TASK = 'schedule_task'
const MAX_TOOL_LOOPS = 15

interface OllamaTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}
interface ChatMessage {
  role: string
  content: string
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[]
}
interface OllamaResponseMessage {
  content?: string
  tool_calls?: { function: { name: string; arguments: any } }[]
}

export class Agent {
  private toolRegistry: ToolRegistry
  private db: BetterSqlite3.Database

  constructor(dataDir: string, db: BetterSqlite3.Database) {
    this.toolRegistry = new ToolRegistry(dataDir)
    this.db = db
  }

  getTools() { return this.toolRegistry.list() }
  getToolRegistry(): ToolRegistry { return this.toolRegistry }
  private modelId(raw: string): string { return raw.replace(/^ollama\//, '') }

  private buildToolDefs(): OllamaTool[] {
    return this.toolRegistry.list().map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  buildToolDescriptions(): string {
    return this.toolRegistry.list().map((t) => {
      const params = t.parameters?.properties ? Object.keys(t.parameters.properties).join(', ') : ''
      return `- ${t.name}(${params}) — ${t.description}`
    }).join('\n')
  }

  async *run(
    model: string,
    messages: { role: string; content: string }[],
    sessionId?: string,
    systemPrompt?: string,
  ): AsyncGenerator<AgentEvent> {
    try {
    let tools = this.buildToolDefs()
    let history = [...messages]
    let systemContent = systemPrompt || SYSTEM_PROMPT_HEAD + this.buildToolDescriptions() + SYSTEM_PROMPT_TAIL

    // ---- RAG injection ----
    if (sessionId && messages.length > 0) {
      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
      if (lastUserMsg) {
        try {
          const queryEmb = await embed(lastUserMsg.content)
          if (queryEmb.length > 0) {
            const memories = searchMemories(this.db, sessionId, queryEmb, 3)
            const knowledge = searchKnowledge(this.db, queryEmb, 3)
            const blocks: string[] = []
            if (memories.length > 0) blocks.push(memories.map((m) => `[relevance: ${(m.score * 100).toFixed(0)}%] ${m.content}`).join('\n\n'))
            if (knowledge.length > 0) blocks.push(knowledge.map((k) => `[from: ${k.documentName}, relevance: ${(k.score * 100).toFixed(0)}%] ${k.content}`).join('\n\n'))
            if (blocks.length > 0) {
              systemContent += `\n\nRELEVANT PAST CONTEXT:\n${blocks.join('\n\n')}`
              log.agent(`RAG: injected ${memories.length} memories + ${knowledge.length} knowledge entries`)
            }
          }
        } catch (err) { log.agent(`RAG query failed: ${err}`) }
      }
    }

    // ---- Context summarization ----
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0)
    if (totalChars > 8000 && history.length > 6) {
      log.agent(`Context too large (${totalChars} chars, ${history.length} msgs), summarizing...`)
      const keepCount = 4
      const oldMsgs = history.slice(0, -keepCount)
      const recentMsgs = history.slice(-keepCount)
      try {
        const summaryRes = await fetch(`${OLLAMA_BASE}/api/generate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.modelId(model), prompt: `Summarize the following conversation concisely, keeping key facts, decisions, and context:\n\n${oldMsgs.map(m => `[${m.role}]: ${m.content.slice(0, 1000)}`).join('\n')}\n\nSummary:`, stream: false, options: { num_ctx: 8192 } }),
          signal: AbortSignal.timeout(120_000),
        })
        if (summaryRes.ok) {
          const summary = ((await summaryRes.json()).response || '').trim()
          if (summary) {
            history = [{ role: 'system', content: `Earlier conversation summary: ${summary}` }, ...recentMsgs]
            log.agent(`Context summarized (${totalChars} → ${history.reduce((s, m) => s + m.content.length, 0)} chars)`)
          }
        }
      } catch (err) { log.agent(`Context summarization failed: ${err}`) }
    }

    const systemMsg: { role: string; content: string } = { role: 'system', content: systemContent }
    const FORCE_TOOL_MSG = forceToolMsg(this.toolRegistry)

    let apiMessages: ChatMessage[] = [systemMsg, ...history]
    let forceTool = false
    let lastToolResult = ''
    let stuckCount = 0
    let dynamicToolAttempts = 0
    let emptyCount = 0

    // ---- Pre-planning: OpenCode solves first-query directly ----
    {
      const hasHistory = messages.some((m) => m.role === 'assistant')
      const lastUserMsg = !hasHistory ? [...messages].reverse().find((m) => m.role === 'user') : null
      if (lastUserMsg) {
        try {
          const query = lastUserMsg.content
          log.agent(`Pre-planning for: "${query.slice(0, 80)}..."`)
          yield { type: 'status', content: 'Analyzing your request...' }

          const toolDomainPattern = /(weather|météo|temps|quel temps|forecast|prévisions? météo|news?|actualité|headlines|generate|draw|create an image|t.v.? guide|tv guide|programme t.v?|ce soir à la t.v?|search.*web|recherche)/i
          const allToolNames = this.toolRegistry.list().map((t) => t.name).join('|')
          const toolNamePattern = new RegExp(`\\b(${allToolNames})\\b`, 'i')
          const actionPattern = /(tous les jours|chaque (jour|semaine|mois)|schedule|remind|rappel|every (day|week|hour|\d+)|daily|weekly|send (to|me)|envoyer|recevoir|${TOOL_SEND_EMAIL}|${TOOL_SCHEDULE_TASK}|write (a|this|the) file|créer|sauvegarder)/i

          if (actionPattern.test(query) || toolDomainPattern.test(query) || toolNamePattern.test(query)) {
            log.agent('Pre-plan: action/tool-domain — skipping to agent loop')
          } else if (await classifyQueryComplexity(query, model, this.modelId.bind(this))) {
            log.agent('Pre-plan: simple query — delegating to Ollama agent loop')
          } else {
            const prePlanResult = await solveWithOpencode(query)
            if (prePlanResult) {
              log.agent(`Pre-plan succeeded (${prePlanResult.length}ch)`)
              yield { type: 'status', content: 'Formatting response...' }
              const formatMessages: ChatMessage[] = [
                { role: 'system', content: 'You are a helpful assistant. Format the following data as a clear answer to the user\'s question. Be concise and natural.' },
                { role: 'user', content: query },
                { role: 'assistant', content: prePlanResult.slice(0, 4000) },
              ]
              const formatRes = await fetch(`${OLLAMA_BASE}/api/chat`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: this.modelId(model), messages: formatMessages, stream: true, options: { num_ctx: 8192 } }),
                signal: AbortSignal.timeout(120_000),
              })
              if (formatRes.ok && formatRes.body) {
                const reader = formatRes.body.getReader()
                const decoder = new TextDecoder()
                let buf = '', fullContent = '', totalChars = 0, thresholdReached = false
                while (true) {
                  const { done, value } = await reader.read()
                  if (done) break
                  buf += decoder.decode(value, { stream: true })
                  const lines = buf.split('\n'); buf = lines.pop() || ''
                  for (const line of lines) {
                    if (!line.trim()) continue
                    try {
                      const chunk = JSON.parse(line)
                      if (chunk.message?.content) {
                        totalChars += chunk.message.content.length
                        fullContent += chunk.message.content
                        if (!thresholdReached && totalChars >= 100) { thresholdReached = true; yield { type: 'text', content: fullContent }; fullContent = '' }
                        else if (thresholdReached && fullContent) { yield { type: 'text', content: fullContent }; fullContent = '' }
                      }
                    } catch { /* skip malformed lines */ }
                  }
                }
                if (thresholdReached && fullContent) yield { type: 'text', content: fullContent }
                if (thresholdReached) { log.agent(`Pre-plan: streamed Ollama response (${totalChars}ch)`); return }
                log.agent(`Pre-plan: Ollama response too short (${totalChars}ch)`)
              } else { log.agent(`Pre-plan: Ollama format call failed (${formatRes.status})`) }
              yield { type: 'text', content: prePlanResult }; return // fallback: raw OpenCode answer
            }
            log.agent('Pre-plan: no direct solution, entering agent loop')
          }
        } catch (err: unknown) { log.agent(`Pre-plan error: ${err instanceof Error ? err.message : String(err)}`) }
      }
    }

    // ---- AI Planning: decompose complex queries into sub-tasks ----
    {
      const hasHistory = messages.some((m) => m.role === 'assistant')
      const query = hasHistory ? '' : (messages.find((m) => m.role === 'user')?.content || '')
      if (query.length > 30) {
        const isComplex = !(await classifyQueryComplexity(query, model, this.modelId.bind(this)))
        if (isComplex) {
          const plan = await planWithOllama(query, model, this.modelId.bind(this), this.buildToolDescriptions())
          if (plan.length > 1) {
            log.agent(`Plan: ${plan.length} steps → ${plan.map(p => p.toolName).join(', ')}`)
            yield { type: 'status', content: `Executing ${plan.length}-step plan...` }
            for (let pi = 0; pi < plan.length; pi++) {
              const step = plan[pi]; const toolRunId = crypto.randomUUID()
              const tool = this.toolRegistry.get(step.toolName)
              yield { type: 'status', content: `Step ${pi + 1}/${plan.length}: ${step.description}` }
              if (tool) {
                yield { type: 'tool_start', toolName: step.toolName, toolRunId, toolArgs: step.toolArgs }
                try {
                  const toolRes = await tool.execute(step.toolArgs as Record<string, any>)
                  const resultText = typeof toolRes === 'string' ? toolRes : toolRes.result
                  const widget = typeof toolRes === 'string' ? undefined : toolRes.widget
                  yield { type: 'tool_end', toolName: step.toolName, toolRunId, toolResult: resultText, widget }
                  apiMessages.push({ role: 'system', content: `[Step ${pi + 1}: ${step.description}]\n${resultText.slice(0, 1500)}` })
                  if (sessionId && resultText.length < 2000) {
                    try { const emb = await embed(resultText.slice(0, 1000)); storeMemory(this.db, sessionId, `[${step.toolName}] ${resultText.slice(0, 500)}`, emb) } catch { /* skip */ }
                  }
                  addToolCall(this.db, { sessionId: sessionId || null, toolName: step.toolName, toolArgs: JSON.stringify(step.toolArgs), toolResult: resultText, durationMs: 0 })
                } catch (err: unknown) {
                  const errm = err instanceof Error ? err.message : String(err)
                  yield { type: 'tool_error', toolName: step.toolName, toolRunId, error: errm }
                  apiMessages.push({ role: 'system', content: `[Step ${pi + 1} FAILED: ${step.toolName}] ${errm}` })
                }
              } else {
                try { const ocResult = await askOpencode(step.description); if (ocResult) apiMessages.push({ role: 'system', content: `[Step ${pi + 1}: ${step.description} via OpenCode]\n${ocResult.slice(0, 1500)}` }) } catch { /* skip */ }
              }
            }
            log.agent('Plan execution complete, entering agent loop for synthesis')
          }
        }
      }
    }

    // ---- Main agent loop (max 15 turns) ----
    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      log.agent(`Loop ${loop + 1}/${MAX_TOOL_LOOPS}  history=${apiMessages.length}msgs`)
      yield { type: 'status', content: loop === 0 ? 'Thinking...' : `Thinking (step ${loop + 1})...` }

      const body: Record<string, unknown> = { model: this.modelId(model), messages: apiMessages, stream: false, options: { num_ctx: 8192 } }
      if (tools.length > 0) body.tools = tools

      const t0 = Date.now()
      const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(300_000),
      })

      if (!res.ok) {
        yield { type: 'error', error: `Ollama API error ${res.status}` }
        return
      }

      const data = await res.json()
      const msg: OllamaResponseMessage = data.message || {}
      const content = msg.content || ''
      const toolCalls = msg.tool_calls

      log.agent(`Ollama ${Date.now() - t0}ms  response=${JSON.stringify({
        model: body.model, content: content.slice(0, 200),
        tool_calls: toolCalls?.map((tc: any) => ({
          name: tc.function?.name,
          args: (typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {})).slice(0, 150),
        })),
      })}`)

      // ---- No tool call ----
      if (!toolCalls || toolCalls.length === 0) {
        const isSuccess = isSuccessConfirmation(content)
        if (isGreetingResponse(content)) { log.agent('Greeting detected, yielding'); yield { type: 'text', content }; return }
        const isAdvisory = isSuccess ? false : await classifyAdvisory(content, model, this.modelId.bind(this))

        if (forceTool && content.trim()) {
          if (isAdvisory && !isSuccess && loop < MAX_TOOL_LOOPS - 1) {
            log.agent('Force-tool advisory, re-prompting')
            apiMessages.push({ role: 'assistant', content }); apiMessages.push(FORCE_TOOL_MSG); continue
          }
          log.agent('Force-tool response accepted, yielding'); yield { type: 'text', content }; return
        }

        if (content.trim()) {
          const weakResult = lastToolResult && (lastToolResult.includes('No results') || lastToolResult.includes('not found') || lastToolResult.includes('Error:') || lastToolResult.includes('Aucun résultat') || lastToolResult.length < 30)
          const givingUp = /(cannot find|could not find|does not contain|don't have|can't find|pas directement|ne contient pas|no relevant|rien trouvé|aucun résultat|je n'ai pas trouvé|je ne peux pas|je ne trouve pas|voici quelques liens|vous pouvez (trouver|consulter|vérifier)|available at|is available on|vous pouvez y trouver|here are some links|check out these)/i.test(content)

          // Priority 0: fabrication without tool
          if (!lastToolResult && content.trim().length > 50 && dynamicToolAttempts < 3) {
            stuckCount++
            const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
            yield { type: 'status', content: 'Finding the answer...' }
            const answer = await askOpencode(lastUserMsg?.content || '')
            if (answer) { dynamicToolAttempts++; yield { type: 'text', content: answer }; return }
          }

          // Priority 1: weak + advisory/giving-up OR stuck for 2+ cycles → escalate to OpenCode.
          if ((weakResult || stuckCount > 0) && (isAdvisory || givingUp || stuckCount > 1) && loop > 0 && dynamicToolAttempts < 3) {
            stuckCount++
            const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
            yield { type: 'status', content: 'Finding a better answer...' }
            const answer = await askOpencode(lastUserMsg?.content || '')
            if (answer) { dynamicToolAttempts++; yield { type: 'text', content: answer }; return }
          }

          // Priority 2: advisory → force tool
          if (isAdvisory && !isSuccess) {
            log.agent('Advisory response, re-prompting for tool use')
            apiMessages.push({ role: 'assistant', content }); apiMessages.push(FORCE_TOOL_MSG); forceTool = true; stuckCount++; continue
          }

          // Priority 3: weak result → try again
          if (weakResult && loop < MAX_TOOL_LOOPS - 1) {
            log.agent(`Weak result, re-prompting`); apiMessages.push({ role: 'assistant', content }); apiMessages.push(PERSIST_MSG); continue
          }

          // Priority 4: giving-up → try again
          if (givingUp && loop > 0 && loop < MAX_TOOL_LOOPS - 1) {
            log.agent('Model gave up, re-prompting'); apiMessages.push({ role: 'assistant', content }); apiMessages.push(PERSIST_MSG); continue
          }

          log.agent('Yielding text response'); yield { type: 'text', content }
        } else {
          // Empty response
          emptyCount++
          if (emptyCount >= 2 && dynamicToolAttempts < 3) {
            const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
            yield { type: 'status', content: 'Finding the answer...' }
            const answer = await askOpencode(lastUserMsg?.content || '')
            if (answer) { dynamicToolAttempts++; yield { type: 'text', content: answer }; return }
          }
          if (loop < MAX_TOOL_LOOPS - 1) {
            log.agent(`Empty response (${emptyCount}x), re-prompting`); apiMessages.push({ role: 'assistant', content: '(no output)' }); apiMessages.push(FORCE_TOOL_MSG); forceTool = true; continue
          }
          log.agent('Empty response, giving up')
        }
        return
      }

      // ---- Tool call(s) ----
      forceTool = false
      for (const tc of toolCalls) {
        const toolName = tc.function.name; const toolRunId = crypto.randomUUID()
        let args: Record<string, unknown> = {}
        if (typeof tc.function.arguments === 'object' && tc.function.arguments !== null) args = tc.function.arguments as Record<string, unknown>
        else try { args = JSON.parse(tc.function.arguments) } catch { args = {} }

        const tool = this.toolRegistry.get(toolName)
        if (!tool) { log.warn(`Tool "${toolName}" not found`); yield { type: 'tool_error', toolName, toolRunId, error: `Tool "${toolName}" not found` }; continue }

        log.agent(`Calling tool ${toolName}`); yield { type: 'tool_start', toolName, toolRunId, toolArgs: args }; yield { type: 'status', content: `Running ${toolName}...` }
        const t1 = Date.now()
        try {
          const chunkQueue: string[] = []; const onChunk = (chunk: string) => { chunkQueue.push(chunk) }
          const toolArgs: Record<string, unknown> = sessionId ? { ...args as Record<string, unknown>, _sessionId: sessionId } : args
          const toolPromise = tool.execute(toolArgs, onChunk)
          let result: string | undefined; let widget: import('./tools/types.js').ToolWidget | undefined

          while (true) {
            const raced = await Promise.race([toolPromise, new Promise<void>((resolve) => setTimeout(resolve, 150))])
            if (raced !== undefined) { if (typeof raced === 'string') result = raced; else { result = raced.result; widget = raced.widget } }
            while (chunkQueue.length > 0) { const c = chunkQueue.shift()!; yield { type: 'tool_chunk', toolName, toolRunId, content: c } }
            if (result !== undefined) {
              log.agent(`Tool ${toolName} completed in ${Date.now() - t1}ms (${result.length}ch)`)
              yield { type: 'tool_end', toolName, toolRunId, toolResult: result, widget }; break
            }
          }

          lastToolResult = result
          if (result.length === 0 && this.toolRegistry.isDynamic(toolName)) { log.agent(`Removing failed dynamic tool "${toolName}"`); this.toolRegistry.unregister(toolName); tools = this.buildToolDefs() }

          apiMessages.push({ role: 'assistant', content: content || '', tool_calls: [{ function: { name: toolName, arguments: tc.function.arguments } }] })
          apiMessages.push({ role: 'tool', content: result })

          if (sessionId && result.length < 2000) { try { const emb = await embed(result.slice(0, 1000)); storeMemory(this.db, sessionId, `[${toolName}] ${result.slice(0, 500)}`, emb) } catch { /* skip */ } }
          addToolCall(this.db, { sessionId: sessionId || null, toolName, toolArgs: JSON.stringify(args), toolResult: result, durationMs: Date.now() - t1 })
        } catch (err: unknown) {
          const errm = err instanceof Error ? err.message : String(err)
          log.agent(`Tool ${toolName} FAILED: ${errm}`); yield { type: 'tool_error', toolName, toolRunId, error: errm }
          lastToolResult = `Error: ${errm}`; apiMessages.push({ role: 'tool', content: `Error: ${errm}` })
          addToolCall(this.db, { sessionId: sessionId || null, toolName, toolArgs: JSON.stringify(args), toolError: errm, durationMs: Date.now() - t1 })
        }
      }
    }

    yield { type: 'error', error: 'Agent exceeded maximum tool call iterations' }
    } catch (err: unknown) {
      yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  }
}
