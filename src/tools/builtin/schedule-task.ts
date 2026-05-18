import type { ToolModule } from '../types.js'
import { createBackgroundTask, listBackgroundTasks, deleteBackgroundTask } from '../../db.js'
import { getNextRun } from '../../scheduler.js'
import type BetterSqlite3 from 'better-sqlite3'

export function createScheduleTool(db: BetterSqlite3.Database): ToolModule {
  return {
    definition: {
      name: 'schedule_task',
      description: `Schedule, unschedule, or list background tasks. Background tasks run automatically at the specified schedule even when you're not in an active conversation.

Examples:
- Schedule: {"action":"schedule","name":"Morning news","schedule":"daily at 08:00","tool":"web_fetch","args":{"q":"latest tech news"}}
- Schedule: {"action":"schedule","name":"Check weather","schedule":"every 1h","tool":"web_fetch","args":{"q":"weather"}}
- Unschedule: {"action":"unschedule","task_id":"...uuid..."}
- List: {"action":"list"}`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"schedule" to create, "unschedule" to remove, "list" to show all', enum: ['schedule', 'unschedule', 'list'] },
          name: { type: 'string', description: 'Human-readable name for the task' },
          schedule: { type: 'string', description: 'When to run. Examples: "every 24h", "every 30m", "daily at 08:00", "daily", "weekly"' },
          tool: { type: 'string', description: 'Tool name to execute (e.g. "web_fetch", "run_bash")' },
          args: { type: 'string', description: 'JSON object of arguments passed to the tool' },
          task_id: { type: 'string', description: 'Task ID to unschedule (required when action=unschedule)' },
        },
        required: ['action'],
      },
    },
    execute: async (args) => {
      const action = args.action as string

      if (action === 'list') {
        const tasks = listBackgroundTasks(db)
        if (tasks.length === 0) return 'No background tasks scheduled.'
        return tasks.map((t) =>
          `- ${t.name} (id: ${t.id.slice(0, 8)}...) tool: ${t.toolName} schedule: ${t.schedule} enabled: ${t.enabled} next_run: ${t.nextRunAt || 'none'} last_run: ${t.lastRunAt || 'never'}`
        ).join('\n')
      }

      if (action === 'unschedule') {
        const taskId = args.task_id as string
        if (!taskId) return 'Please provide a "task_id" to unschedule.'
        deleteBackgroundTask(db, taskId)
        return `Background task ${taskId.slice(0, 8)}... has been unscheduled.`
      }

      if (action === 'schedule') {
        const name = args.name as string
        const schedule = args.schedule as string
        const tool = args.tool as string
        let toolArgs: string
        if (typeof args.args === 'string') {
          toolArgs = args.args || '{}'
        } else if (args.args && typeof args.args === 'object') {
          toolArgs = JSON.stringify(args.args)
        } else {
          toolArgs = '{}'
        }

        if (!name) return 'Please provide a "name" for the task.'
        if (!schedule) return 'Please provide a "schedule" (e.g. "every 24h", "daily at 08:00").'
        if (!tool) return 'Please provide a "tool" name to execute.'

        // Validate tool args JSON
        try { JSON.parse(toolArgs) } catch { return `Invalid JSON in "args": ${toolArgs}` }

        const nextRunAt = getNextRun(schedule).toISOString()

        const task = createBackgroundTask(db, {
          sessionId: args._sessionId as string || '',
          name,
          schedule,
          toolName: tool,
          toolArgs,
          enabled: true,
          nextRunAt,
        })

        return `Background task "${name}" scheduled! ID: ${task.id.slice(0, 8)}... Next run: ${nextRunAt} (${schedule}). Use schedule_task with action=list to view all tasks.`
      }

      return `Unknown action "${action}". Use "schedule", "unschedule", or "list".`
    },
  }
}
