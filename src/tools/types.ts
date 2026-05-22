export interface ToolParameter {
  type: string
  description: string
  enum?: string[]
  items?: { type: string }
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, ToolParameter>
    required: string[]
  }
  code?: string
  language?: 'javascript' | 'python' | 'bash'
}

export interface ToolModule {
  definition: ToolDefinition
  execute: (args: Record<string, any>, onChunk?: (chunk: string) => void) => Promise<string | ToolResult>
}

export interface ToolWidget {
  type: string
  data: Record<string, unknown>
}

export interface ToolResult {
  result: string
  widget?: ToolWidget
}

export interface ToolCall {
  name: string
  arguments: Record<string, any>
}

export interface AgentEvent {
  type: 'text' | 'tool_start' | 'tool_chunk' | 'tool_end' | 'tool_error' | 'status' | 'done' | 'error'
  content?: string
  toolName?: string
  toolRunId?: string
  toolArgs?: Record<string, any>
  toolResult?: string
  widget?: ToolWidget
  error?: string
}
