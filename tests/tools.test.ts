import { describe, it, expect } from 'vitest'
import {
  TOOL_SCHEDULE_TASK,
  TOOL_SEARCH_KNOWLEDGE,
  TOOL_SEND_EMAIL,
  TOOL_SEND_TELEGRAM,
  TOOL_CREATE_TOOL,
} from '../src/tools/constants.js'

describe('tool name constants', () => {
  it('TOOL_SCHEDULE_TASK has correct value', () => {
    expect(TOOL_SCHEDULE_TASK).toBe('schedule_task')
  })

  it('TOOL_SEARCH_KNOWLEDGE has correct value', () => {
    expect(TOOL_SEARCH_KNOWLEDGE).toBe('search_knowledge')
  })

  it('TOOL_SEND_EMAIL has correct value', () => {
    expect(TOOL_SEND_EMAIL).toBe('send_email')
  })

  it('TOOL_SEND_TELEGRAM has correct value', () => {
    expect(TOOL_SEND_TELEGRAM).toBe('send_telegram')
  })

  it('TOOL_CREATE_TOOL has correct value', () => {
    expect(TOOL_CREATE_TOOL).toBe('create_tool')
  })
})
