import type { AgentEvent } from './tools/types.js'

export type { AgentEvent } from './tools/types.js'
export type { ToolDefinition, ToolModule, ToolCall } from './tools/types.js'

export interface Message {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
}

export interface Session {
  id: string
  name: string
  model: string
  createdAt: string
  updatedAt: string
}

export interface StreamChunk {
  type: 'text' | 'tool_start' | 'tool_end' | 'tool_error' | 'done' | 'error'
  content?: string
  toolName?: string
  toolArgs?: Record<string, any>
  toolResult?: string
  error?: string
}

export function agentEventToChunk(event: AgentEvent): StreamChunk {
  return {
    type: event.type,
    content: event.content,
    toolName: event.toolName,
    toolArgs: event.toolArgs,
    toolResult: event.toolResult,
    error: event.error,
  }
}
