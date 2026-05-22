// OpenCode delegation bridge — used for pre-planning and dynamic answers.

import { runOpencodeTask } from '../opencode.js'
import { log } from '../log.js'

export async function solveWithOpencode(userQuery: string): Promise<string | null> {
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

    const results = await Promise.allSettled(
      prompts.map((p) => {
        const taskPromise = runOpencodeTask(p)
        taskPromise.catch(() => { /* suppress unhandled rejection */ })
        return Promise.race([
          taskPromise,
          new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT)),
        ])
      })
    )

    for (const settled of results) {
      if (settled.status === 'fulfilled') {
        const text = settled.value.trim()
        if (text.length > 100) {
          log.agent(`Pre-plan round ${round + 1}: ${text.length}ch (${Date.now() - t0}ms)`)
          return text
        }
        log.agent(`Pre-plan round ${round + 1}: too short (${text.length}ch)`)
      }
    }
  }

  log.agent(`Pre-plan: no answer after ${maxRounds} rounds`)
  return null
}

export async function askOpencode(prompt: string): Promise<string | null> {
  const t0 = Date.now()
  log.agent(`Dynamic answer for: "${prompt.slice(0, 80)}..."`)
  try {
    const answer = await Promise.race([
      runOpencodeTask(
        `Answer this question directly. Use web_search if you need current data. Be thorough and accurate. Answer in the user's language:\n\n${prompt}`,
      ),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 60_000)),
    ])
    const trimmed = answer.trim()
    if (trimmed.length > 50) {
      log.agent(`Dynamic answer: ${trimmed.length}ch (${Date.now() - t0}ms)`)
      return trimmed
    }
    log.agent(`Dynamic answer too short (${trimmed.length}ch)`)
  } catch (err: unknown) {
    log.agent(`Dynamic answer failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return null
}
