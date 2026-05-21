/**
 * ws.ts — WebSocket handler for real-time chat streaming
 *
 * Replaces the old SSE (Server-Sent Events) endpoint.  The Angular client
 * connects to ws://host/ws, sends a JSON message `{ type: "chat",
 * sessionId, message }`, and receives streamed AgentEvent chunks until
 * a `done` or `error` event closes the conversation.
 *
 * Key design points:
 *  - A 15-second ping interval keeps the connection alive during long
 *    agent turns (Ollama calls, OpenCode planning, tool execution).
 *  - A `busy` flag prevents a second chat request on the same socket
 *    from interfering with an in-progress one.
 *  - On completion the assistant's full response is persisted to the DB
 *    as a message, and "New Session" is auto-renamed to the user's first
 *    message (truncated to 50 chars).
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'http'
import type Database from 'better-sqlite3'
import type { Agent } from './agent.js'
import { getSession, getMessages, addMessage, updateSessionName } from './db.js'
import { agentEventToChunk } from './types.js'
import { log } from './log.js'

const PING_INTERVAL = 15_000

export function createWebSocket(server: Server, db: Database.Database, agent: Agent) {
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws: WebSocket) => {
    let currentSessionId: string | null = null
    let busy = false
    let pingTimer: ReturnType<typeof setInterval> | null = null

    // Periodic ping to prevent idle connection drops (proxies, browsers, etc.)
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping()
      }
    }, PING_INTERVAL)

    const cleanup = () => {
      if (pingTimer) {
        clearInterval(pingTimer)
        pingTimer = null
      }
      currentSessionId = null
      busy = false
    }

    ws.on('message', async (raw) => {
      // Reject concurrent chat requests on the same socket.
      if (busy) {
        ws.send(JSON.stringify({ type: 'error', error: 'session busy' }))
        return
      }

      let msg: any
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'invalid JSON' }))
        return
      }

      if (msg.type === 'chat') {
        const { sessionId, message } = msg
        if (!sessionId || !message) {
          ws.send(JSON.stringify({ type: 'error', error: 'sessionId and message required' }))
          return
        }

        const session = getSession(db, sessionId)
        if (!session) {
          ws.send(JSON.stringify({ type: 'error', error: 'Session not found' }))
          return
        }

        currentSessionId = sessionId
        busy = true
        log.info(`WS chat  session=${session.id.slice(0, 8)} msg="${message.slice(0, 60)}${message.length > 60 ? '...' : ''}"`)

        // Persist the user message immediately.
        addMessage(db, { sessionId: session.id, role: 'user', content: message })

        // Rename "New Session" immediately on first message (don't wait for response).
        if (session.name === 'New Session' && message.length > 10) {
          const shortName = message.length > 50 ? message.slice(0, 50) + '...' : message
          updateSessionName(db, session.id, shortName)
        }

        const history = getMessages(db, session.id)
        const ollamaMessages = history.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }))

        let fullResponse = ''
        let eventCount = 0
        const startTime = Date.now()

        try {
          // Consume the agent's async generator and forward each event
          // as a JSON chunk over the WebSocket.
          for await (const event of agent.run(session.model, ollamaMessages, session.id)) {
            if (ws.readyState !== WebSocket.OPEN) break
            eventCount++
            const chunk = agentEventToChunk(event)
            ws.send(JSON.stringify(chunk))

            if (event.type === 'tool_start') {
              log.sse(`tool_start ${event.toolName}`)
            } else if (event.type === 'tool_end') {
              log.sse(`tool_end   ${event.toolName}`)
            } else if (event.type === 'status') {
              log.sse(`status     ${event.content?.slice(0, 60)}`)
            } else if (event.type === 'text') {
              fullResponse += event.content || ''
            }
          }

          // Signal completion to the client.
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'done' }))
          }

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          log.info(`Done  session=${session.id.slice(0, 8)} events=${eventCount} duration=${elapsed}s chars=${fullResponse.length}`)

          // Persist the assistant's full response as a message.
          if (fullResponse) {
            addMessage(db, { sessionId: session.id, role: 'assistant', content: fullResponse })
          }

        } catch (err: any) {
          log.error(`Chat error: ${err.message}`)
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', error: err.message }))
          }
        } finally {
          busy = false
        }
      }
    })

    ws.on('close', cleanup)
    ws.on('error', cleanup)
  })

  return wss
}