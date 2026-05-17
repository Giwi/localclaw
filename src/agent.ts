import type { AgentEvent } from './tools/types.js'
import type { ToolDefinition } from './tools/types.js'
import type Database from 'better-sqlite3'
import { ToolRegistry } from './tools/registry.js'
import { log } from './log.js'
import { storeMemory, searchMemories, searchKnowledge } from './db.js'
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

const SYSTEM_PROMPT_HEAD = `You are localclaw, an autonomous AI agent running on Ollama with tools. You are proactive, curious, and solution-oriented.

CORE BEHAVIOR:
- Be proactive: explore, investigate, and act without waiting for instructions
- When the user states a problem or goal, immediately use tools to work toward a solution
- Use multiple tool calls in sequence to gather information, test ideas, and build things
- If something doesn't work, try a different approach — don't give up
- Suggest improvements and ideas the user might not have considered

SEARCH STRATEGIES:
- To find content on a specific site: first try fetching the site URL directly (q="https://example.com"), then try broader searches
- Use short, keyword-based queries without quotes for better results
- If a search returns irrelevant results, try a different query or fetch the intended URL directly

Available tools:
`

const SYSTEM_PROMPT_TAIL = `
GUIDELINES:
- Search the web when you need information, look up documentation, or find solutions
- Explore the user's filesystem and codebase to understand context before suggesting changes
- Create tools with create_tool when you need to process data, generate things, or automate repetitive work
- When asked for pictures: use web_fetch with mode="images" then display with ![alt](url), or use generate_image to create new images
- NEVER make up URLs or domain names. Verify domains exist before using them.
- When stuck, try a different approach or tool — there's always another way`

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
      content: `You did NOT call any tool. Call a tool NOW. Use ${this.toolRegistry.list().filter(t => !['send_email','send_telegram','schedule_task'].includes(t.name)).slice(0, 5).map(t => t.name).join(', ')}, or another tool. Do not apologize — just call one.`,
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
          yield { type: 'done' }
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
          log.agent('Empty response from model')
        }
        yield { type: 'done' }
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

        try {
          const t1 = Date.now()
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
        } catch (err: any) {
          log.agent(`Tool ${toolName} FAILED: ${err.message}`)
          yield { type: 'tool_error', toolName, toolRunId, error: err.message }
          lastToolResult = `Error: ${err.message}`
          apiMessages.push({ role: 'tool', content: `Error: ${err.message}` })
        }
      }
    }

    yield { type: 'error', error: 'Agent exceeded maximum tool call iterations' }
  }
}
