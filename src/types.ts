import type { AgentEvent } from './tools/types.js'

export type { AgentEvent } from './tools/types.js'
export type { ToolDefinition, ToolModule, ToolCall } from './tools/types.js'

export interface Message {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  toolResults?: string
}

export interface Session {
  id: string
  name: string
  model: string
  createdAt: string
  updatedAt: string
}

export interface BackgroundTask {
  id: string
  sessionId: string
  name: string
  schedule: string
  toolName: string
  toolArgs: string
  enabled: boolean
  lastRunAt: string | null
  nextRunAt: string | null
  lastResult: string | null
  lastError: string | null
  retries: number
  maxRetries: number
  createdAt: string
}

export interface StreamChunk {
  type: 'text' | 'tool_start' | 'tool_chunk' | 'tool_end' | 'tool_error' | 'status' | 'done' | 'error'
  content?: string
  toolName?: string
  toolRunId?: string
  toolArgs?: Record<string, any>
  toolResult?: string
  widget?: { type: string; data: Record<string, unknown> }
  error?: string
}

export function agentEventToChunk(event: AgentEvent): StreamChunk {
  return {
    type: event.type,
    content: event.content,
    toolName: event.toolName,
    toolRunId: event.toolRunId,
    toolArgs: event.toolArgs,
    toolResult: event.toolResult,
    widget: event.widget,
    error: event.error,
  }
}
