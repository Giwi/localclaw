import type { AgentEvent } from './tools/types.js'
import type { ToolDefinition } from './tools/types.js'
import type Database from 'better-sqlite3'
import { ToolRegistry } from './tools/registry.js'
import { log } from './log.js'
import { storeMemory, searchMemories, searchKnowledge, addToolCall } from './db.js'
import { embed } from './embeddings.js'

const OLLAMA_BASE = process.env.LOCALCLAW_OLLAMA_URL || 'http://localhost:11434'
const MAX_TOOL_LOOPS = 15

interface OllamaTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ToolDefinition['parameters']
  }
}

interface OllamaResponseMessage {
  role: string
  content?: string
  tool_calls?: Array<{
    function: {
      name: string
      arguments: string
    }
  }>
}

const SYSTEM_PROMPT_HEAD = `You are localclaw, an autonomous AI agent. You think and act independently — break down problems, execute plans, and verify results without waiting for permission.

APPROACH:
- When given a goal, first plan the steps needed. Then execute them one by one using tools.
- Break complex tasks into sub-tasks. Complete each sub-task fully before moving to the next.
- Use multiple tool calls in sequence — each call builds on the previous result.
- After getting results, verify they actually answer the question. If not, try a different approach.
- Proactively suggest improvements, alternatives, and next steps the user might not have considered.

EXECUTION STRATEGIES:
- Don't just describe what you would do — actually do it. Call tools and produce real results.
- If a tool returns an error, try a different method. If a search finds nothing, try a different query.
- Chain tools together: search → read → analyze → write. Each step feeds the next.
- When exploring codebases: read multiple files, understand the structure, then act.
- For web content: always fetch the actual URL rather than guessing what's there.
- Use create_tool to build custom utilities when existing tools aren't enough.
- When using send_email or send_telegram, gather ALL required data first with other tools (fetch_news, weather, web_fetch, etc.). Never send placeholders like [data], [résumé], or [summary]. If you don't have the real data yet, use tools to get it before composing the message.
- send_telegram: the chat_id is already configured in LOCALCLAW_TELEGRAM_CHAT_ID — omit the chat_id argument to use it. Do NOT call get_chat_id unless the send fails with "env var is missing".

VERIFICATION:
- Before presenting a final answer, check: "Did I fully answer what was asked?"
- If the result is incomplete, partial, or unclear, run another tool to fill the gap.
- Never say "I couldn't find anything" without trying at least 3 different approaches.

Available tools:
`

const SYSTEM_PROMPT_TAIL = `
DECISION-MAKING:
- You are an autonomous agent — act like one. Don't ask the user for permission or instructions.
- When you see a problem, fix it. When you see an opportunity, explore it. When you have an idea, implement it.
- Make independent choices: which tools to use, what order to call them, what information to gather.
- If the user asks something vague, interpret their intent and take the most useful action.
- After completing a task, offer to do more: "I've done X. I also noticed Y — should I look into that?"

CREATIVITY:
- Don't just answer — build things. Write scripts, create tools, generate images, schedule tasks.
- If a tool doesn't exist for something, create it with create_tool.
- Use write_file to create documents, scripts, and artifacts the user can actually use.
- Use opencode_task for complex multi-file coding projects.
- Combine scheduled tasks with email or Telegram to build automated workflows.

ALWAYS:
- Call tools to produce real output. Never just describe what you would do.
- If you hit a dead end, try a radically different approach — not the same thing again.
- After presenting results, suggest next steps or related things the user might want.`

export class Agent {
  private toolRegistry: ToolRegistry
  private db: Database.Database

  constructor(dataDir: string, db: Database.Database) {
    this.toolRegistry = new ToolRegistry(dataDir)
    this.db = db
  }

  getTools() {
    return this.toolRegistry.list()
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry
  }

  private modelId(raw: string): string {
    return raw.replace(/^ollama\//, '')
  }

  private buildToolDefs(): OllamaTool[] {
    return this.toolRegistry.list().map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }))
  }

  private buildToolDescriptions(): string {
    const tools = this.toolRegistry.list()
    return tools.map((t) => {
      const params = t.parameters?.properties
        ? Object.keys(t.parameters.properties).join(', ')
        : ''
      return `- ${t.name}(${params}) — ${t.description}`
    }).join('\n')
  }

  async *run(
    model: string,
    messages: { role: string; content: string }[],
    sessionId?: string,
    systemPrompt?: string
  ): AsyncGenerator<AgentEvent> {
    const tools = this.buildToolDefs()
    let history = [...messages]

    let systemContent = systemPrompt || SYSTEM_PROMPT_HEAD + this.buildToolDescriptions() + SYSTEM_PROMPT_TAIL

    // RAG: retrieve relevant memories and global knowledge for the last user message
    if (sessionId && messages.length > 0) {
      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
      if (lastUserMsg) {
        try {
          const queryEmb = await embed(lastUserMsg.content)
          if (queryEmb.length > 0) {
            // Session-scoped memory from past tool results
            const memories = searchMemories(this.db, sessionId, queryEmb, 3)
            // Global knowledge from uploaded documents
            const knowledge = searchKnowledge(this.db, queryEmb, 3)

            const blocks: string[] = []
            if (memories.length > 0) {
              blocks.push(memories.map((m) => `[relevance: ${(m.score * 100).toFixed(0)}%] ${m.content}`).join('\n\n'))
            }
            if (knowledge.length > 0) {
              blocks.push(knowledge.map((k) => `[from: ${k.documentName}, relevance: ${(k.score * 100).toFixed(0)}%] ${k.content}`).join('\n\n'))
            }
            if (blocks.length > 0) {
              systemContent += `\n\nRELEVANT PAST CONTEXT:\n${blocks.join('\n\n')}`
              log.agent(`RAG: injected ${memories.length} memories + ${knowledge.length} knowledge entries`)
            }
          }
        } catch (err) {
          log.agent(`RAG query failed: ${err}`)
        }
      }
    }

    // Context window management: summarize old messages if history is too large
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0)
    if (totalChars > 8000 && history.length > 6) {
      log.agent(`Context too large (${totalChars} chars, ${history.length} msgs), summarizing...`)
      const keepCount = 4 // keep last 2 exchanges (user + assistant)
      const oldMsgs = history.slice(0, -keepCount)
      const recentMsgs = history.slice(-keepCount)

      try {
        const summaryRes = await fetch(`${OLLAMA_BASE}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.modelId(model),
            prompt: `Summarize the following conversation concisely, keeping key facts, decisions, and context:\n\n${oldMsgs.map(m => `[${m.role}]: ${m.content.slice(0, 1000)}`).join('\n')}\n\nSummary:`,
            stream: false,
            options: { num_ctx: 4096 },
          }),
        })
        if (summaryRes.ok) {
          const summaryData = await summaryRes.json()
          const summary = (summaryData.response || '').trim()
          if (summary) {
            history = [{ role: 'system', content: `Earlier conversation summary: ${summary}` }, ...recentMsgs]
            log.agent(`Context summarized (${totalChars} → ${history.reduce((s, m) => s + m.content.length, 0)} chars)`)
          }
        }
      } catch (err) {
        log.agent(`Context summarization failed: ${err}`)
      }
    }

    const systemMsg: { role: string; content: string } = {
      role: 'system',
      content: systemContent,
    }

    const FORCE_TOOL_MSG: { role: string; content: string } = {
      role: 'system',
      content: `You did NOT call any tool. Call a tool NOW. Use ${this.toolRegistry.list().filter(t => !['send_email','schedule_task'].includes(t.name)).slice(0, 5).map(t => t.name).join(', ')}, or another tool. Do not apologize — just call one.`,
    }

    let apiMessages: any[] = [systemMsg, ...history]
    let forceTool = false
    let lastToolResult = ''

    const PERSIST_MSG: { role: string; content: string } = {
      role: 'system',
      content: 'Your previous attempt did not find useful results. Try a completely different approach — different search query (shorter, fewer quotes), fetch the site URL directly, or use a different tool. Do NOT repeat the same query.',
    }

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      log.agent(`Loop ${loop + 1}/${MAX_TOOL_LOOPS}  history=${apiMessages.length}msgs`)

      const body: any = {
        model: this.modelId(model),
        messages: apiMessages,
        stream: false,
        options: { num_ctx: 8192 },
      }

      if (tools.length > 0) {
        body.tools = tools
      }

      const t0 = Date.now()
      const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        log.error(`Ollama API error ${res.status}: ${errText}`)
        yield { type: 'error', error: `Ollama API error ${res.status}: ${errText}` }
        return
      }

      const data = await res.json()
      const elapsed = Date.now() - t0
      const msg: OllamaResponseMessage = data.message || {}
      const content = msg.content || ''
      const toolCalls = msg.tool_calls

      // Log the full Ollama response (truncated)
      const responseLog = JSON.stringify({
        model: body.model,
        content: content.slice(0, 200),
        tool_calls: toolCalls?.map((tc: any) => ({
          name: tc.function?.name,
          args: typeof tc.function?.arguments === 'string'
            ? tc.function.arguments.slice(0, 150)
            : JSON.stringify(tc.function?.arguments).slice(0, 150),
        })),
      })
      log.agent(`Ollama ${elapsed}ms  response=${responseLog}`)

      if (!toolCalls || toolCalls.length === 0) {
        if (forceTool && content.trim()) {
          log.agent('Force-tool response accepted, yielding text')
          yield { type: 'text', content }
          return
        }

        if (content.trim()) {
          const isAdvisory = /(you can|you could|i suggest|try using|you need to|you should)/i.test(content)
          if (isAdvisory && !forceTool) {
            log.agent(`Advisory response detected, re-prompting for tool use`)
            apiMessages.push({ role: 'assistant', content })
            apiMessages.push(FORCE_TOOL_MSG)
            forceTool = true
            continue
          }

          // If the last tool result was unsatisfactory, persist
          const weakResult = lastToolResult && (
            lastToolResult.includes('No results') ||
            lastToolResult.includes('no images') ||
            lastToolResult.includes('No images') ||
            lastToolResult.includes('not found') ||
            lastToolResult.includes('Error:') ||
            lastToolResult.includes('empty') ||
            lastToolResult.length < 30
          )
          if (weakResult && loop < MAX_TOOL_LOOPS - 1) {
            log.agent(`Weak result (${lastToolResult.slice(0, 60)}...), re-prompting for another attempt`)
            apiMessages.push({ role: 'assistant', content })
            apiMessages.push(PERSIST_MSG)
            continue
          }

          // If the model is giving up instead of trying harder, persist
          const givingUp = /(cannot find|could not find|does not contain|don't have|can't find|doesn't seem|couldn't locate|not directly|pas directement|ne contient pas|ne contiennent pas|doesn't contain|no relevant|rien trouvé|aucun résultat|n'a pas trouvé)/i.test(content)
          if (givingUp && loop > 0 && loop < MAX_TOOL_LOOPS - 1) {
            log.agent('Model gave up after tool use, re-prompting for another attempt')
            apiMessages.push({ role: 'assistant', content })
            apiMessages.push(PERSIST_MSG)
            continue
          }

          log.agent('Yielding text response')
          yield { type: 'text', content }
        } else {
          if (loop < MAX_TOOL_LOOPS - 1) {
            log.agent('Empty response from model, re-prompting')
            apiMessages.push({ role: 'assistant', content: '(no output)' })
            apiMessages.push(FORCE_TOOL_MSG)
            forceTool = true
            continue
          }
          log.agent('Empty response from model, giving up')
        }
        return
      }

      forceTool = false

      for (const tc of toolCalls) {
        const toolName = tc.function.name
        const toolRunId = crypto.randomUUID()
        let args: Record<string, any> = {}
        if (typeof tc.function.arguments === 'object' && tc.function.arguments !== null) {
          args = tc.function.arguments as Record<string, any>
        } else {
          try {
            args = JSON.parse(tc.function.arguments)
          } catch {
            args = {}
          }
        }

        const tool = this.toolRegistry.get(toolName)
        if (!tool) {
          log.warn(`Tool "${toolName}" not found in registry`)
          yield { type: 'tool_error', toolName, toolRunId, error: `Tool "${toolName}" not found` }
          continue
        }

        log.agent(`Calling tool ${toolName}`)
        yield { type: 'tool_start', toolName, toolRunId, toolArgs: args }

        const t1 = Date.now()
        try {
          const chunkQueue: string[] = []
          const onChunk = (chunk: string) => { chunkQueue.push(chunk) }
          const toolArgs = sessionId ? { ...args, _sessionId: sessionId } : args
          const toolPromise = tool.execute(toolArgs, onChunk)

          // Flush chunks periodically while tool runs, for real-time streaming
          let result: string | undefined
          while (true) {
            const raced = await Promise.race([
              toolPromise,
              new Promise<void>((resolve) => setTimeout(resolve, 150)),
            ])
            if (raced !== undefined) result = raced as string

            while (chunkQueue.length > 0) {
              const c = chunkQueue.shift()!
              log.agent(`Tool ${toolName} chunk: ${c.slice(0, 60)}`)
              yield { type: 'tool_chunk', toolName, toolRunId, content: c }
            }
            if (result !== undefined) {
              const telapsed = Date.now() - t1
              log.agent(`Tool ${toolName} completed in ${telapsed}ms (${result.length}ch)`)
              yield { type: 'tool_end', toolName, toolRunId, toolResult: result }
              break
            }
          }

          lastToolResult = result

          apiMessages.push({
            role: 'assistant',
            content: content || '',
            tool_calls: [{ function: { name: toolName, arguments: tc.function.arguments } }],
          })
          apiMessages.push({ role: 'tool', content: result })

          // Store tool result as memory for RAG
          if (sessionId && result.length < 2000) {
            try {
              const emb = await embed(result.slice(0, 1000))
              storeMemory(this.db, sessionId, `[${toolName}] ${result.slice(0, 500)}`, emb)
            } catch { /* skip memory storage on failure */ }
          }

          addToolCall(this.db, {
            sessionId: sessionId || null,
            toolName,
            toolArgs: JSON.stringify(args),
            toolResult: result,
            durationMs: Date.now() - t1,
          })
        } catch (err: any) {
          log.agent(`Tool ${toolName} FAILED: ${err.message}`)
          yield { type: 'tool_error', toolName, toolRunId, error: err.message }
          lastToolResult = `Error: ${err.message}`
          apiMessages.push({ role: 'tool', content: `Error: ${err.message}` })
          addToolCall(this.db, {
            sessionId: sessionId || null,
            toolName,
            toolArgs: JSON.stringify(args),
            toolError: err.message,
            durationMs: Date.now() - t1,
          })
        }
      }
    }

    yield { type: 'error', error: 'Agent exceeded maximum tool call iterations' }
  }
}
