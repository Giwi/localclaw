import type { AgentEvent } from './tools/types.js'
import type { ToolDefinition } from './tools/types.js'
import { ToolRegistry } from './tools/registry.js'
import { log } from './log.js'

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

const SYSTEM_PROMPT = `You are localclaw, an autonomous AI agent running on Ollama with tools. You are proactive, curious, and solution-oriented.

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
- web_fetch(q, mode) — search the web or fetch a URL. Set q="your query" to search, q="https://..." for a specific page, mode="images" for pictures.
- run_bash(command) — execute any bash command to explore the system, install packages, run scripts, etc.
- write_file(path, content) — write or create any file
- read_file(path) — read any file to understand the codebase or system
- opencode_task(task) — delegate complex multi-step coding tasks to the coding agent
- create_tool(name, description, language, code, parameters) — create a new reusable tool on the fly (supports python, javascript, bash)

GUIDELINES:
- Search the web when you need information, look up documentation, or find solutions
- Explore the user's filesystem and codebase to understand context before suggesting changes
- Create tools with create_tool when you need to process data, generate things, or automate repetitive work
- When asked for pictures: use web_fetch with mode="images" then display with ![alt](url)
- NEVER make up URLs or domain names. Verify domains exist before using them.
- When stuck, try a different approach or tool — there's always another way`

export class Agent {
  private toolRegistry: ToolRegistry

  constructor(dataDir: string) {
    this.toolRegistry = new ToolRegistry(dataDir)
  }

  getTools() {
    return this.toolRegistry.list()
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

  async *run(
    model: string,
    messages: { role: string; content: string }[],
    systemPrompt?: string
  ): AsyncGenerator<AgentEvent> {
    const tools = this.buildToolDefs()
    let history = [...messages]

    const systemMsg: { role: string; content: string } = {
      role: 'system',
      content: systemPrompt || SYSTEM_PROMPT,
    }

    const FORCE_TOOL_MSG: { role: string; content: string } = {
      role: 'system',
      content: 'You did NOT call any tool. Call a tool NOW. Use web_fetch, run_bash, opencode_task, or create_tool. Do not apologize — just call one.',
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
          yield { type: 'tool_error', toolName, error: `Tool "${toolName}" not found` }
          continue
        }

        log.agent(`Calling tool ${toolName}`)
        yield { type: 'tool_start', toolName, toolArgs: args }

        try {
          const t1 = Date.now()
          const result = await tool.execute(args)
          const telapsed = Date.now() - t1
          log.agent(`Tool ${toolName} completed in ${telapsed}ms (${result.length}ch)`)
          yield { type: 'tool_end', toolName, toolResult: result }

          lastToolResult = result

          apiMessages.push({
            role: 'assistant',
            content: content || '',
            tool_calls: [{ function: { name: toolName, arguments: tc.function.arguments } }],
          })
          apiMessages.push({ role: 'tool', content: result })
        } catch (err: any) {
          log.agent(`Tool ${toolName} FAILED: ${err.message}`)
          yield { type: 'tool_error', toolName, error: err.message }
          lastToolResult = `Error: ${err.message}`
          apiMessages.push({ role: 'tool', content: `Error: ${err.message}` })
        }
      }
    }

    yield { type: 'error', error: 'Agent exceeded maximum tool call iterations' }
  }
}
