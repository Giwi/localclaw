import type BetterSqlite3 from 'better-sqlite3'
import type { BackgroundTask } from './types.js'
import { getDueTasks, updateBackgroundTask, addMessage, getSession } from './db.js'
import type { ToolRegistry } from './tools/registry.js'
import { log } from './log.js'

const CHECK_INTERVAL = 30_000

function parseSchedule(schedule: string): { type: 'interval' | 'daily'; minutes: number; time?: string } {
  const s = schedule.toLowerCase().trim()

  const minMatch = s.match(/every\s+(\d+)\s*m(?:in(?:ute)?s?)?\b/)
  if (minMatch) return { type: 'interval', minutes: Math.max(parseInt(minMatch[1]), 1) }

  const hourMatch = s.match(/every\s+(\d+)\s*h(?:ou)?r?s?\b/)
  if (hourMatch) return { type: 'interval', minutes: Math.max(parseInt(hourMatch[1]) * 60, 1) }

  const dailyMatch = s.match(/(?:daily|every\s+day)\s*(?:at\s+)?(\d{1,2}):(\d{2})\b/)
  if (dailyMatch) return { type: 'daily', minutes: 24 * 60, time: `${dailyMatch[1].padStart(2, '0')}:${dailyMatch[2]}` }

  if (/(?:daily|every\s+day|once\s+a\s+day)/.test(s)) return { type: 'interval', minutes: 24 * 60 }
  if (/(?:weekly|every\s+week)/.test(s)) return { type: 'interval', minutes: 7 * 24 * 60 }

  return { type: 'interval', minutes: 24 * 60 }
}

function getNextRun(schedule: string, after: Date = new Date()): Date {
  const parsed = parseSchedule(schedule)
  if (parsed.type === 'interval') {
    return new Date(after.getTime() + parsed.minutes * 60 * 1000)
  }
  const [h, m] = parsed.time!.split(':').map(Number)
  const next = new Date(after)
  next.setHours(h, m, 0, 0)
  if (next.getTime() <= after.getTime()) next.setDate(next.getDate() + 1)
  return next
}

export { parseSchedule, getNextRun }

export class BackgroundScheduler {
  private db: BetterSqlite3.Database
  private registry: ToolRegistry
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(db: BetterSqlite3.Database, registry: ToolRegistry) {
    this.db = db
    this.registry = registry
  }

  start(): void {
    if (this.timer) return
    log.agent('Background scheduler started (interval: 30s)')
    this.timer = setInterval(() => this.tick(), CHECK_INTERVAL)
    this.tick()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    try {
      const tasks = getDueTasks(this.db)
      for (const task of tasks) {
        await this.executeTask(task)
      }
    } catch (err: any) {
      log.agent(`Scheduler tick error: ${err.message}`)
    }
  }

  private async executeTask(task: BackgroundTask): Promise<void> {
    const tool = this.registry.get(task.toolName)
    if (!tool) {
      log.agent(`Scheduler: tool "${task.toolName}" not found for task "${task.name}"`)
      const nextRun = getNextRun(task.schedule)
      updateBackgroundTask(this.db, task.id, { lastError: `Tool "${task.toolName}" not found`, nextRunAt: nextRun.toISOString() })
      return
    }

    log.agent(`Scheduler: executing task "${task.name}" (tool: ${task.toolName})`)

    let result: string
    let error: string | null = null
    try {
      const args = JSON.parse(task.toolArgs || '{}')
      result = await tool.execute(args)
    } catch (err: any) {
      result = ''
      error = err.message
      log.agent(`Scheduler: task "${task.name}" FAILED: ${error}`)
    }

    const now = new Date()
    let nextRun: Date
    let newRetries = task.retries

    if (error && task.retries < task.maxRetries) {
      // Exponential backoff: 1min, 5min, 15min, 30min, 60min...
      const backoffMinutes = [1, 5, 15, 30, 60][Math.min(task.retries, 4)]
      nextRun = new Date(now.getTime() + backoffMinutes * 60 * 1000)
      newRetries = task.retries + 1
      log.agent(`Scheduler: task "${task.name}" will retry in ${backoffMinutes}min (attempt ${newRetries}/${task.maxRetries})`)
    } else {
      nextRun = getNextRun(task.schedule)
      newRetries = 0
    }

    updateBackgroundTask(this.db, task.id, {
      lastRunAt: now.toISOString(),
      lastResult: result || null,
      lastError: error,
      nextRunAt: nextRun.toISOString(),
      retries: newRetries,
    })

    const session = getSession(this.db, task.sessionId)
    if (session && (error || result)) {
      const status = error ? 'failed' : 'completed'
      const retryNote = error && task.retries < task.maxRetries
        ? ` (retry ${task.retries + 1}/${task.maxRetries} in ${((nextRun.getTime() - now.getTime()) / 60000).toFixed(0)}min)`
        : ''
      const msgContent = `[Background task "${task.name}" ${status} at ${now.toLocaleTimeString()}]${retryNote}\n${error ? `Error: ${error}` : `Result: ${result!.slice(0, 1000)}`}`
      addMessage(this.db, { sessionId: task.sessionId, role: 'system', content: msgContent })
      log.agent(`Scheduler: stored result for session ${task.sessionId.slice(0, 8)}`)
    }
  }
}
