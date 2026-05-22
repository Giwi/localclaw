/**
 * agent.ts — Core agent loop
 *
 * This module implements the main "agentic loop" that drives the entire chat
 * experience.  The high-level flow for each incoming message is:
 *
 *   1. RAG — embed the last user message, retrieve relevant memories &
 *      knowledge chunks from the DB, and inject them into the system prompt.
 *
 *   2. Context summarization — if the conversation history exceeds ~8 000
 *      characters, older messages are summarized down to a short paragraph so
 *      the Ollama context window doesn't overflow.
 *
 *   3. Pre-planning — before the Ollama model even sees the message, OpenCode
 *      (an external CLI agent) analyses the query and proactively generates a
 *      bash one-liner tool when appropriate.  This gives small local models a
 *      concrete tool they can call from the very first turn instead of
 *      hallucinating.
 *
 *   4. Agent loop — up to 15 iterations of:
 *      a. Send messages to Ollama → get a response (text + optional tool_calls).
 *      b. If the model called a tool:  execute it, stream chunks back to the
 *         client, and append the result to the conversation.
 *      c. If the model produced text only (no tool call):  analyse the text for
 *         various failure modes and decide whether to re-prompt, create a
 *         dynamic tool, or yield the text as the final answer.
 *
 *   Failure-mode handling (priorities):
 *     Priority 0  —  Model fabricated content without calling any tool.
 *                    → Create a dynamic tool via OpenCode and inject it.
 *     Priority 1  —  A previous tool produced a weak result AND the model is
 *                    either being advisory or giving up.
 *                    → Create another dynamic tool via OpenCode.
 *     Priority 2  —  Advisory text ("you can try …", "voici quelques
 *                    ressources …") instead of action.
 *                    → Re-prompt with a force-tool message.
 *     Priority 3  —  Weak tool result (empty, "not found", etc.).
 *                    → Re-prompt with a "try harder" message.
 *     Priority 4  —  Giving-up text ("I couldn't find …", "je ne trouve pas").
 *                    → Re-prompt with a "try harder" message.
 *
 *   Dynamic tools are created via OpenCode (see opencode.ts) and registered
 *   using the `registerDynamic()` method which bypasses the normal test-run
 *   step.  Up to 3 attempts are allowed per conversation (dynamicToolAttempts).
 *   Tools that return 0 characters are automatically unregistered so the
 *   model can't loop on a broken tool.
 *
 *   All events (text, tool_start, tool_chunk, tool_end, tool_error, status,
 *   done, error) are yielded as an AsyncGenerator.  The WebSocket handler in
 *   ws.ts consumes this generator and forwards JSON chunks to the client.
 */

import type { AgentEvent } from './tools/types.js'
import type { ToolDefinition } from './tools/types.js'
import type Database from 'better-sqlite3'
import { ToolRegistry } from './tools/registry.js'
import { log } from './log.js'
import { storeMemory, searchMemories, searchKnowledge, addToolCall } from './db.js'
import { embed } from './embeddings.js'
import { runOpencodeTask } from './opencode.js'
import { TOOL_SEND_EMAIL, TOOL_SCHEDULE_TASK } from './tools/constants.js'

const OLLAMA_BASE = process.env.LOCALCLAW_OLLAMA_URL || 'http://localhost:11434'
const MAX_TOOL_LOOPS = 15

// ---------- Ollama API types ----------

interface OllamaTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ToolDefinition['parameters']
  }
}

interface ChatMessage {
  role: string
  content: string
  tool_calls?: Array<{ function: { name: string; arguments: string } }>
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

// ---------- System prompts ----------

const SYSTEM_PROMPT_HEAD = `You are localclaw, an autonomous AI agent. You think, act, and take initiative independently.

CORE IDENTITY:
- You are not a chatbot — you are an autonomous agent. Your job is to anticipate, act, and deliver.
- Don't wait for instructions. If you see something useful, do it. If you spot a problem, fix it.
- Be curious. Check the weather, read the news, review schedules — unprompted.
- Suggest things the user hasn't asked for. Surprise them with useful information.
- If the user asks something simple, answer it AND look for what else might help them.

APPROACH:
- Anticipate what the user needs before they ask. If they ask about weather, also note the forecast trend.
- When given a goal, plan steps and execute them immediately — no discussion, no permission-seeking.
- Break complex tasks into sub-tasks. Complete each fully before moving to the next.
- Use multiple tool calls in sequence. Each call builds on the previous result.
- After getting results, think "what else would be useful here?" and do that too.

EXECUTION STRATEGIES:
- Act before describing. Call tools, produce real results, then explain what you did.
- If a tool returns an error, try a different method. If a search finds nothing, try a different query.
- Chain tools together: search → read → analyze → write. Each step feeds the next.
- When exploring codebases: read multiple files, understand the structure, then act.
- For web content: always fetch the actual URL rather than guessing what is there.
- Use create_tool to build custom utilities when existing tools aren't enough.
- When using send_email or send_telegram, gather ALL required data first with other tools (fetch_news, weather, web_fetch, etc.). Never send placeholders like [data], [résumé], or [summary]. If you don't have the real data yet, use tools to get it before composing the message.
- send_telegram: the chat_id is already configured in LOCALCLAW_TELEGRAM_CHAT_ID — omit the chat_id argument to use it. Do NOT call get_chat_id unless the send fails with "env var is missing".

VERIFICATION:
- Before presenting a final answer, check: "Did I fully answer what was asked?"
- If the result is incomplete, partial, or unclear, run another tool to fill the gap.
- Never say "I couldn't find anything" without trying at least 3 different approaches.
- After answering, add something extra — a relevant suggestion, a proactive check, or a useful follow-up.

Available tools:
`

const SYSTEM_PROMPT_TAIL = `
INITIATIVE:
- Take the lead. After answering, ask yourself "what should I do next?" and do it.
- If the user hasn't messaged in a while and there are scheduled tasks, mention upcoming ones.
- Check the weather or news for the user's area automatically when relevant.
- Set up background tasks without being asked when you see recurring needs.
- Use opencode_task proactively for complex work — don't wait to be told.

AUTONOMY:
- Never ask "should I do X?" — just do it and report what you did.
- When you see a problem, fix it. When you see an opportunity, explore it.
- Make independent choices: which tools to use, what order, what to gather.
- If the user asks something vague, interpret their intent and take the most useful action.
- After completing a task, do something extra. Check on a scheduled task, review the news, suggest an improvement.

CREATIVITY:
- Don't just answer — build things. Write scripts, create tools, generate images, schedule tasks.
- If a tool doesn't exist for something, create it with create_tool.
- Use write_file to create documents, scripts, and artifacts the user can actually use.
- Use opencode_task for complex multi-file coding projects.
- Combine scheduled tasks with email or Telegram to build automated workflows.

ALWAYS:
- Call tools to produce real output. Never just describe what you would do.
- If you hit a dead end, try a radically different approach — not the same thing again.
- After presenting results, suggest next steps or related things the user might want.
- Answer in the same language the user wrote their message in. If they write in French, answer in French. If they write in English, answer in English. Match their language exactly.`

// ---------- Agent class ----------

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

  /** Strip the "ollama/" prefix that some configs include. */
  private modelId(raw: string): string {
    return raw.replace(/^ollama\//, '')
  }

  /** Build the tool definitions array in the format Ollama expects. */
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

  /** Build a human-readable bullet list of tools for the system prompt. */
  private buildToolDescriptions(): string {
    const tools = this.toolRegistry.list()
    return tools.map((t) => {
      const params = t.parameters?.properties
        ? Object.keys(t.parameters.properties).join(', ')
        : ''
      return `- ${t.name}(${params}) — ${t.description}`
    }).join('\n')
  }

  /**
   * Fast Ollama check: is the user's query a simple greeting, small talk, or
   * trivial question that doesn't need OpenCode's full power?
   *
   * Returns true if the query can be handled by Ollama alone (skip pre-plan).
   */
  private async classifyQueryComplexity(query: string, model: string): Promise<boolean> {
    try {
      const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.modelId(model),
          prompt: `You are a query complexity classifier. Does the user's message require external tools, current data, or complex reasoning to answer? Answer ONLY "SIMPLE" (greetings, small talk, basic questions) or "COMPLEX" (requires tools, research, code, files, web search, calculations, scheduling).

Query: "${query.slice(0, 200)}"`,
          stream: false,
          options: { num_predict: 10, temperature: 0 },
        }),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return false
      const data = await res.json()
      return (data.response || '').toUpperCase().includes('SIMPLE')
    } catch {
      // On error, assume complex to be safe
      return false
    }
  }

  /**
   * Ask OpenCode to answer the user's question directly.
   *
   * Runs multiple prompts in parallel across 2 rounds.  OpenCode is a capable
   * agent (often Claude) with web_search, file reading, and other tools — it
   * can answer questions directly without needing us to generate bash commands.
   *
   * Returns the best answer text (>100 chars) or null.
   */
  private async solveWithOpencode(userQuery: string): Promise<string | null> {
    const t0 = Date.now()
    const maxRounds = 2
    const TIMEOUT = 60_000

    for (let round = 0; round < maxRounds; round++) {
      const prompts = round === 0
        ? [
            `Answer this question concisely. Use any tools you need (web_search, bash, read_file). Answer in the user's language:\n\n${userQuery}`,
            `Find the answer and respond in the user's language. Use web_search if you need current data. Be concise:\n\n${userQuery}`,
            `Answer in the user's language:\n\n${userQuery}`,
          ]
        : [
            `Your previous attempts didn't produce a useful answer. Try a completely different approach. Answer in the user's language:\n\n${userQuery}`,
            `Search the web for current information, then answer concisely in the user's language:\n\n${userQuery}`,
          ]

      log.agent(`Pre-plan round ${round + 1}/${maxRounds} (${prompts.length} prompts)`)

      const opencodeResults = await Promise.allSettled(
        prompts.map((p) => {
          const taskPromise = runOpencodeTask(p)
          taskPromise.catch(() => { /* suppress unhandled rejection on timeout */ })
          return Promise.race([
            taskPromise,
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT)),
          ])
        })
      )

      for (const settled of opencodeResults) {
        if (settled.status === 'fulfilled') {
          const text = settled.value.trim()
          if (text.length > 100) {
            log.agent(`Pre-plan round ${round + 1}: OpenCode returned ${text.length}ch (${Date.now() - t0}ms)`)
            return text
          }
          log.agent(`Pre-plan round ${round + 1}: too short (${text.length}ch): "${text.slice(0, 80)}"`)
        }
      }
    }

    log.agent(`Pre-plan: no useful answer after ${maxRounds} rounds (${Date.now() - t0}ms)`)
    return null
  }

  /**
   * Ask OpenCode to answer the question directly and return the text.
   * Used when the pre-plan didn't produce a result or the agent loop is stuck.
   *
   * Returns the answer text, or null if OpenCode produced nothing useful.
   */
  private async askOpencode(userQuery: string, sessionId?: string): Promise<string | null> {
    const t0 = Date.now()
    log.agent(`Creating dynamic answer for: "${userQuery.slice(0, 80)}..."`)
    try {
      const answer = await Promise.race([
        runOpencodeTask(
          `Answer this question directly. Use web_search if you need current data. Be thorough and accurate. Answer in the user's language:\n\n${userQuery}`,
        ),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 60_000)),
      ])
      const trimmed = answer.trim()
      if (trimmed.length > 50) {
        log.agent(`Dynamic answer: ${trimmed.length}ch (${Date.now() - t0}ms): "${trimmed.slice(0, 120)}..."`)
        return trimmed
      }
      log.agent(`Dynamic answer too short (${trimmed.length}ch): "${trimmed.slice(0, 80)}"`)
    } catch (err: unknown) {
      log.agent(`Dynamic answer failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return null
  }

  /**
   * Classify whether a model response is advisory (suggesting/refusing/avoiding)
   * or a direct answer.  Uses Ollama for classification with regex fallback.
   */
  private async classifyAdvisory(content: string, model: string): Promise<boolean> {
    try {
      const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.modelId(model),
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
    } catch {}
    // Fallback: regex patterns
    return /(i suggest|try using|you need to|you should|i will|i'll|let me|going to|can you|could you|please provide|je suggère|essayez d'utiliser|vous devez|je vais|laissez-moi|je propose|je peux vous|je pourrais|voici quelques|ressources|vous pouvez consulter|tu peux trouver|here are some)/i.test(content)
  }

  /**
   * Main agent loop — an async generator that yields events for the
   * WebSocket handler to forward to the client.
   *
   * Each event is one of:  text | tool_start | tool_chunk | tool_end |
   * tool_error | status | done | error
   */
  async *run(
    model: string,
    messages: { role: string; content: string }[],
    sessionId?: string,
    systemPrompt?: string
  ): AsyncGenerator<AgentEvent> {
    try {
    let tools = this.buildToolDefs()
    let history = [...messages]

    let systemContent = systemPrompt || SYSTEM_PROMPT_HEAD + this.buildToolDescriptions() + SYSTEM_PROMPT_TAIL

    // ---- RAG: inject relevant past context into the system prompt ----
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

    // ---- Context summarization: keep the window under ~8 000 chars ----
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
            options: { num_ctx: 8192 },
          }),
          signal: AbortSignal.timeout(120_000),
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

    // ---- Re-prompt messages used when the model is being unhelpful ----

    const systemMsg: { role: string; content: string } = {
      role: 'system',
      content: systemContent,
    }

    // Sent when the model responds with text but was told to call a tool.
    const FORCE_TOOL_MSG: { role: string; content: string } = {
      role: 'system',
      content: `You did NOT call any tool. Call a tool NOW. Use ${this.toolRegistry.list().filter(t => ![TOOL_SEND_EMAIL, TOOL_SCHEDULE_TASK].includes(t.name)).slice(0, 5).map(t => t.name).join(', ')}, or another tool. Do not apologize — just call one. / Vous n'avez appelé aucun outil. Utilisez un outil immédiatement.`,
    }

    // Sent after a weak / empty tool result to push the model toward a
    // different approach.
    const PERSIST_MSG: { role: string; content: string } = {
      role: 'system',
      content: 'Your previous attempt did not find useful results. Try a completely different approach — different search query (shorter, fewer quotes), fetch the site URL directly, or use a different tool. Do NOT repeat the same query. / Votre tentative précédente n\'a pas donné de résultats. Essayez une approche complètement différente.',
    }

    let apiMessages: ChatMessage[] = [systemMsg, ...history]

    // ---- Loop state ----
    let forceTool = false          // When true, the model MUST call a tool or its text is force-yielded.
    let lastToolResult = ''        // Most recent tool result (for weak-result detection).
    let stuckCount = 0             // How many times we had to re-prompt / create dynamic tools.
    let dynamicToolAttempts = 0    // How many times OpenCode was called to create dynamic tools (max 3).
    let emptyCount = 0             // How many consecutive empty responses we've seen from Ollama.

    // ---- Pre-planning: OpenCode solves first-query directly ----
    //
    // For the very first user message in a conversation, OpenCode answers
    // directly — this saves time on simple queries.  Once the conversation
    // has history (assistant messages exist), we skip pre-plan so follow-up
    // questions are handled by the agent loop which has full context.
    {
      const hasHistory = messages.some((m) => m.role === 'assistant')
      const lastUserMsg = !hasHistory ? [...messages].reverse().find((m) => m.role === 'user') : null
      if (lastUserMsg) {
        try {
          const query = lastUserMsg.content
          log.agent(`Pre-planning for: "${query.slice(0, 80)}..."`)
          yield { type: 'status', content: 'Analyzing your request...' }

          // Queries targeting a registered tool's domain skip pre-plan so
          // the agent loop can use the tool directly instead of OpenCode.
          const toolDomainPattern = /(weather|météo|temps|quel temps|forecast|prévisions? météo|news?|actualité|headlines|generate|draw|create an image|t.v.? guide|tv guide|programme t.v?|ce soir à la t.v?|search.*web|recherche)/i
          // Also match registered tool names directly.
          const allToolNames = this.toolRegistry.list().map((t) => t.name).join('|')
          const toolNamePattern = new RegExp(`\\b(${allToolNames})\\b`, 'i')

          // Action requests skip pre-plan and go directly to the agent loop.
          const actionPattern = /(tous les jours|chaque (jour|semaine|mois)|schedule|remind|rappel|every (day|week|hour|\d+)|daily|weekly|send (to|me)|envoyer|recevoir|${TOOL_SEND_EMAIL}|${TOOL_SCHEDULE_TASK}|write (a|this|the) file|créer|sauvegarder)/i
          if (actionPattern.test(query) || toolDomainPattern.test(query) || toolNamePattern.test(query)) {
            log.agent('Pre-plan: action/tool-domain request — skipping to agent loop')
          } else if (await this.classifyQueryComplexity(query, model)) {
            log.agent('Pre-plan: simple query — delegating to Ollama agent loop')
          } else {
            const prePlanResult = await this.solveWithOpencode(query)

            if (prePlanResult) {
              log.agent(`Pre-plan succeeded (${prePlanResult.length}ch)`)

              // Ask Ollama to present the answer in the user's language using
              // a clean formatting prompt (no agent system prompt that could
              // confuse the model into trying to call tools).
              yield { type: 'status', content: 'Formatting response...' }
              const formatMessages: ChatMessage[] = [
                { role: 'system', content: 'You are a helpful assistant. Format the following data as a clear answer to the user\'s question. Be concise and natural.' },
                { role: 'user', content: query },
                { role: 'assistant', content: prePlanResult.slice(0, 4000) },
              ]

              const formatRes = await fetch(`${OLLAMA_BASE}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  model: this.modelId(model),
                  messages: formatMessages,
                  stream: true,
                  options: { num_ctx: 8192 },
                }),
                signal: AbortSignal.timeout(120_000),
              })

              if (formatRes.ok && formatRes.body) {
                const reader = formatRes.body.getReader()
                const decoder = new TextDecoder()
                let buf = ''
                let fullContent = ''
                let totalChars = 0
                let thresholdReached = false

                while (true) {
                  const { done, value } = await reader.read()
                  if (done) break
                  buf += decoder.decode(value, { stream: true })
                  const lines = buf.split('\n')
                  buf = lines.pop() || ''

                  for (const line of lines) {
                    if (!line.trim()) continue
                    try {
                      const chunk = JSON.parse(line)
                      if (chunk.message?.content) {
                        totalChars += chunk.message.content.length
                        fullContent += chunk.message.content
                        if (!thresholdReached && totalChars >= 100) {
                          thresholdReached = true
                          yield { type: 'text', content: fullContent }
                          fullContent = ''
                        } else if (thresholdReached && fullContent) {
                          yield { type: 'text', content: fullContent }
                          fullContent = ''
                        }
                      }
                    } catch { /* skip malformed lines */ }
                  }
                }

                if (thresholdReached && fullContent) {
                  yield { type: 'text', content: fullContent }
                }

                if (thresholdReached) {
                  log.agent(`Pre-plan: streamed Ollama condensed response (${totalChars}ch)`)
                  return
                }
                log.agent(`Pre-plan: Ollama condensed response too short (${totalChars}ch), yielding raw`)
              } else {
                log.agent(`Pre-plan: Ollama format call failed (${formatRes.status})`)
              }

              // Fallback: yield the raw OpenCode answer.
              yield { type: 'text', content: prePlanResult }
              return
            }

            log.agent(`Pre-plan: no direct solution, entering agent loop`)
          }

        } catch (err: unknown) {
          log.agent(`Pre-plan error: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    // ---- Main agent loop (max 15 turns) ----
    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      log.agent(`Loop ${loop + 1}/${MAX_TOOL_LOOPS}  history=${apiMessages.length}msgs`)
      yield { type: 'status', content: loop === 0 ? 'Thinking...' : `Thinking (step ${loop + 1})...` }

      const body: Record<string, unknown> = {
        model: this.modelId(model),
        messages: apiMessages,
        stream: false,
        options: { num_ctx: 8192 },
      }

      if (tools.length > 0) {
        body.tools = tools
      }

      // ---- Call the Ollama chat API ----
      const t0 = Date.now()
      const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
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
        tool_calls: toolCalls?.map((tc) => ({
          name: tc.function?.name,
          args: typeof tc.function?.arguments === 'string'
            ? tc.function.arguments.slice(0, 150)
            : JSON.stringify(tc.function?.arguments).slice(0, 150),
        })),
      })
      log.agent(`Ollama ${elapsed}ms  response=${responseLog}`)

      // ========================
      //  NO TOOL CALL RESPONSE
      // ========================
      if (!toolCalls || toolCalls.length === 0) {

        // Detect "advisory" text where the model avoids action.
        // Skip classification for clear success confirmations (fast path).
        const isSuccess = /(successfully scheduled|successfully created|task has been|background task|cron task|scheduled task|tâche a été|planifiée avec succès|programmée pour)/i.test(content)
        const isAdvisory = isSuccess ? false : await this.classifyAdvisory(content, model)

        // ---- Forced-tool mode: model was told to call a tool but didn't ----
        if (forceTool && content.trim()) {
          if (isAdvisory && !isSuccess && loop < MAX_TOOL_LOOPS - 1) {
            log.agent('Force-tool advisory response, re-prompting again')
            apiMessages.push({ role: 'assistant', content })
            apiMessages.push(FORCE_TOOL_MSG)
            continue
          }
          // Non-advisory text after a force-tool prompt: accept it as final.
          log.agent('Force-tool response accepted, yielding text')
          yield { type: 'text', content }
          return
        }

        if (content.trim()) {

          // ---- Detect weak / unhelpful tool results ----
          // These patterns signal the previous tool didn't return useful data.
          const weakResult = lastToolResult && (
            lastToolResult.includes('No results') ||
            lastToolResult.includes('No news found') ||
            lastToolResult.includes('no images') ||
            lastToolResult.includes('No images') ||
            lastToolResult.includes('not found') ||
            lastToolResult.includes('Error:') ||
            lastToolResult.includes('empty') ||
            lastToolResult.includes('Aucun résultat') ||
            lastToolResult.includes('introuvable') ||
            lastToolResult.includes('Erreur:') ||
            lastToolResult.includes('vide') ||
            lastToolResult.includes('Aucune actualité') ||
            lastToolResult.length < 30
          )

          // Detect "giving up" language (English + French).
          const givingUp = /(cannot find|could not find|does not contain|don't have|can't find|doesn't seem|couldn't locate|not directly|pas directement|ne contient pas|ne contiennent pas|doesn't contain|no relevant|rien trouvé|aucun résultat|n'a pas trouvé|je n'ai pas trouvé|je ne peux pas|je ne trouve pas|impossible de trouver|aucune information|pas d'information)/i.test(content)

          // Priority 0: Model produced detailed text without calling any tool — likely fabricated.
          // → Ask OpenCode to answer directly.
          if (!lastToolResult && content.trim().length > 50 && dynamicToolAttempts < 3) {
            stuckCount++
            const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
            yield { type: 'status', content: 'Finding the answer...' }
            const answer = await this.askOpencode(lastUserMsg?.content || '')
            if (answer) {
              dynamicToolAttempts++
              yield { type: 'text', content: answer }
              return
            }
            log.agent('Could not get dynamic answer, falling back')
          }

          // Priority 1: A tool was tried but returned weak data, AND the model
          // is being advisory or giving up. → Get a direct answer from OpenCode.
          if ((weakResult || stuckCount > 0) && (isAdvisory || givingUp) && loop > 0 && dynamicToolAttempts < 3) {
            stuckCount++
            const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
            yield { type: 'status', content: 'Finding a better answer...' }
            const answer = await this.askOpencode(lastUserMsg?.content || '')
            if (answer) {
              dynamicToolAttempts++
              yield { type: 'text', content: answer }
              return
            }
            log.agent('Could not get dynamic answer, falling back')
          }

          // Priority 2: Advisory language detected.  Re-prompt with a demand
          // to call a tool instead.  Also increments stuckCount so the next
          // advisory iteration will trigger Priority 1 (dynamic tool creation).
          if (isAdvisory && !isSuccess) {
            log.agent(`Advisory response detected, re-prompting for tool use`)
            apiMessages.push({ role: 'assistant', content })
            apiMessages.push(FORCE_TOOL_MSG)
            forceTool = true
            stuckCount++
            continue
          }

          // Priority 3: Weak tool result (empty, "not found", etc.)
          // → Tell the model to try a different approach.
          if (weakResult && loop < MAX_TOOL_LOOPS - 1) {
            log.agent(`Weak result (${lastToolResult.slice(0, 60)}...), re-prompting for another attempt`)
            apiMessages.push({ role: 'assistant', content })
            apiMessages.push(PERSIST_MSG)
            continue
          }

          // Priority 4: Giving-up language after tool use
          // → Push the model to keep trying.
          if (givingUp && loop > 0 && loop < MAX_TOOL_LOOPS - 1) {
            log.agent('Model gave up after tool use, re-prompting for another attempt')
            apiMessages.push({ role: 'assistant', content })
            apiMessages.push(PERSIST_MSG)
            continue
          }

          // None of the failure patterns matched — yield the text as the final answer.
          log.agent('Yielding text response')
          yield { type: 'text', content }

        // ---- Empty response (no content, no tool call) ----
        } else {
          emptyCount++

          // After 2 empty responses, try getting a direct answer from OpenCode.
          if (emptyCount >= 2 && dynamicToolAttempts < 3) {
            const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
            yield { type: 'status', content: 'Finding the answer...' }
            const answer = await this.askOpencode(lastUserMsg?.content || '')
            if (answer) {
              dynamicToolAttempts++
              yield { type: 'text', content: answer }
              return
            }
          }

          // Less than 2 empties — just re-prompt with the force-tool message.
          if (loop < MAX_TOOL_LOOPS - 1) {
            log.agent(`Empty response from model (${emptyCount}x), re-prompting`)
            apiMessages.push({ role: 'assistant', content: '(no output)' })
            apiMessages.push(FORCE_TOOL_MSG)
            forceTool = true
            continue
          }
          log.agent('Empty response from model, giving up')
        }
        return
      }

      // ===========================
      //  TOOL CALL(S) IN RESPONSE
      // ===========================

      forceTool = false

      for (const tc of toolCalls) {
        const toolName = tc.function.name
        const toolRunId = crypto.randomUUID()
        let args: Record<string, unknown> = {}
        if (typeof tc.function.arguments === 'object' && tc.function.arguments !== null) {
          args = tc.function.arguments as Record<string, unknown>
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
        yield { type: 'status', content: `Running ${toolName}...` }

        const t1 = Date.now()
        try {
          // Stream tool output chunks to the client every 150 ms while
          // the tool is running, so long-running tools feel responsive.
          const chunkQueue: string[] = []
          const onChunk = (chunk: string) => { chunkQueue.push(chunk) }
          const toolArgs: Record<string, unknown> = sessionId ? { ...args as Record<string, unknown>, _sessionId: sessionId } : args
          const toolPromise = tool.execute(toolArgs, onChunk)

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

          // Remove dynamic tools that returned nothing so the model
          // can't loop on a broken tool.
          if (result.length === 0 && this.toolRegistry.isDynamic(toolName)) {
            log.agent(`Removing failed dynamic tool "${toolName}" (0ch result)`)
            this.toolRegistry.unregister(toolName)
            tools = this.buildToolDefs()
          }

          // Append the tool call + result to the conversation for the next Ollama turn.
          apiMessages.push({
            role: 'assistant',
            content: content || '',
            tool_calls: [{ function: { name: toolName, arguments: tc.function.arguments } }],
          })
          apiMessages.push({ role: 'tool', content: result })

          // Store tool result as a memory embedding for future RAG retrieval.
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
        } catch (err: unknown) {
          const errm = err instanceof Error ? err.message : String(err)
          log.agent(`Tool ${toolName} FAILED: ${errm}`)
          yield { type: 'tool_error', toolName, toolRunId, error: errm }
          lastToolResult = `Error: ${errm}`
          apiMessages.push({ role: 'tool', content: `Error: ${errm}` })
          addToolCall(this.db, {
            sessionId: sessionId || null,
            toolName,
            toolArgs: JSON.stringify(args),
            toolError: errm,
            durationMs: Date.now() - t1,
          })
        }
      }
    }

    // If we exhausted all 15 loops without returning, emit an error.
    yield { type: 'error', error: 'Agent exceeded maximum tool call iterations' }
    } catch (err: unknown) {
      const errm = err instanceof Error ? err.message : String(err)
      log.error(`Unhandled agent error: ${errm}`)
      yield { type: 'error', error: errm }
    }
  }
}