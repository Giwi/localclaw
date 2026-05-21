import chalk from 'chalk'

const LOG_LEVEL = (process.env.LOCALCLAW_LOG_LEVEL || 'info').toLowerCase()

type Level = 'debug' | 'info' | 'warn' | 'error'
const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function shouldLog(level: Level): boolean {
  return (LEVELS[level] ?? 1) >= (LEVELS[LOG_LEVEL as Level] ?? 1)
}

function ts(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false })
}

export const log = {
  debug(msg: string, ...args: unknown[]) {
    if (!shouldLog('debug')) return
    console.log(chalk.dim(`[${ts()}]`) + chalk.gray(' DEBUG ') + msg, ...args)
  },
  info(msg: string, ...args: unknown[]) {
    if (!shouldLog('info')) return
    console.log(chalk.dim(`[${ts()}]`) + chalk.blue(' INFO  ') + msg, ...args)
  },
  warn(msg: string, ...args: unknown[]) {
    if (!shouldLog('warn')) return
    console.log(chalk.dim(`[${ts()}]`) + chalk.yellow(' WARN  ') + msg, ...args)
  },
  error(msg: string, ...args: unknown[]) {
    if (!shouldLog('error')) return
    console.log(chalk.dim(`[${ts()}]`) + chalk.red(' ERROR ') + msg, ...args)
  },
  api(method: string, path: string, status: number, ms: number) {
    if (!shouldLog('info')) return
    const statusColored =
      status >= 500 ? chalk.red(status) : status >= 400 ? chalk.yellow(status) : chalk.green(status)
    console.log(
      chalk.dim(`[${ts()}]`) +
        chalk.magenta(' API   ') +
        chalk.cyan(method.padEnd(6)) +
        statusColored +
        chalk.dim(` ${path}`) +
        chalk.dim(` (${ms}ms)`)
    )
  },
  agent(msg: string, ...args: unknown[]) {
    if (!shouldLog('info')) return
    console.log(chalk.dim(`[${ts()}]`) + chalk.green(' AGENT ') + msg, ...args)
  },
  sse(msg: string, ...args: unknown[]) {
    if (!shouldLog('debug')) return
    console.log(chalk.dim(`[${ts()}]`) + chalk.cyan(' SSE   ') + msg, ...args)
  },
}
