import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'http'
import type Database from 'better-sqlite3'
import type { Agent } from './agent.js'
import { getSession, getMessages, addMessage, updateSessionName } from './db.js'
import { agentEventToChunk } from './types.js'
import { log } from './log.js'

export function createWebSocket(server: Server, db: Database.Database, agent: Agent) {
  const wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws: WebSocket) => {
    let currentSessionId: string | null = null

    ws.on('message', async (raw) => {
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
        log.info(`WS chat  session=${session.id.slice(0, 8)} msg="${message.slice(0, 60)}${message.length > 60 ? '...' : ''}"`)

        addMessage(db, { sessionId: session.id, role: 'user', content: message })

        const history = getMessages(db, session.id)
        const ollamaMessages = history.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }))

        let fullResponse = ''
        let eventCount = 0
        const startTime = Date.now()

        try {
          for await (const event of agent.run(session.model, ollamaMessages, session.id)) {
            if (ws.readyState !== WebSocket.OPEN) break
            eventCount++
            const chunk = agentEventToChunk(event)
            ws.send(JSON.stringify(chunk))

            if (event.type === 'tool_start') {
              log.sse(`tool_start ${event.toolName}`)
            } else if (event.type === 'tool_end') {
              log.sse(`tool_end   ${event.toolName}`)
            } else if (event.type === 'text') {
              fullResponse += event.content || ''
            }
          }

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'done' }))
          }

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          log.info(`Done  session=${session.id.slice(0, 8)} events=${eventCount} duration=${elapsed}s chars=${fullResponse.length}`)

          if (fullResponse) {
            addMessage(db, { sessionId: session.id, role: 'assistant', content: fullResponse })
          }

          if (session.name === 'New Session' && message.length > 10) {
            const shortName = message.length > 50 ? message.slice(0, 50) + '...' : message
            updateSessionName(db, session.id, shortName)
          }
        } catch (err: any) {
          log.error(`Chat error: ${err.message}`)
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', error: err.message }))
          }
        }
      }
    })

    ws.on('close', () => {
      currentSessionId = null
    })
  })

  return wss
}
