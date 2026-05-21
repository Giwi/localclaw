import path from 'path'
import type { ToolModule } from '../types.js'
import { log } from '../../log.js'
import { execSync } from 'child_process'
import type { ExecSyncOptions } from 'child_process'

const EXEC_OPTS: ExecSyncOptions = { encoding: 'utf-8', timeout: 30000, shell: '/bin/bash' }
const CHROMIUM_PATH = '/snap/bin/chromium'

async function chromiumFetch(url: string, script?: string): Promise<string> {
  const safeUrl = url.replace(/"/g, '\\"')
  let evalScript = ''

  if (script) {
    evalScript = `--eval "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`
  }

  const cmd = `${CHROMIUM_PATH} --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --virtual-time-budget=15000 --dump-dom ${evalScript} "${safeUrl}" 2>/dev/null`
  return (execSync(cmd, EXEC_OPTS) as string).trim()
}

async function chromiumScreenshot(url: string): Promise<string> {
  const tmpFile = `/tmp/localclaw_screenshot_${Date.now()}.png`
  const safeUrl = url.replace(/"/g, '\\"')
  const cmd = `${CHROMIUM_PATH} --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --virtual-time-budget=10000 --screenshot="${tmpFile}" --window-size=1280,900 "${safeUrl}" 2>/dev/null`
  execSync(cmd, EXEC_OPTS)
  return tmpFile
}

export const browserAutomationTool: ToolModule = {
  definition: {
    name: 'browser_automation',
    description: 'Navigate to a webpage and extract its content using a real headless browser. Supports taking screenshots. Use this when a site requires JavaScript to render content (SPAs, dynamic pages, login forms).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full URL to navigate to (must start with http:// or https://)' },
        action: { type: 'string', description: '"fetch" to get page text, "screenshot" to capture a screenshot (default: fetch)', enum: ['fetch', 'screenshot'] },
        wait_selector: { type: 'string', description: 'Optional CSS selector to wait for before extracting content (e.g. ".article-content", "#main")' },
      },
      required: ['url'],
    },
  },
  execute: async (args, onChunk) => {
    const url = (args.url || '').trim()
    const action = (args.action || 'fetch') as string
    const waitSelector = (args.wait_selector || '').trim()

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return 'Please provide a valid URL starting with http:// or https://.'
    }

    // Verify domain resolves first
    try {
      execSync(`host "${new URL(url).hostname}" 2>/dev/null || dig +short "${new URL(url).hostname}" 2>/dev/null`, { ...EXEC_OPTS, timeout: 5000 })
    } catch {
      return `Cannot resolve domain "${new URL(url).hostname}" — this domain does not exist.`
    }

    try {
      if (action === 'screenshot') {
        onChunk?.(`Taking screenshot of ${url}...`)
        const filePath = await chromiumScreenshot(url)
        const port = process.env.LOCALCLAW_PORT || '4173'
        const dataDir = process.env.LOCALCLAW_DATA_DIR || `${process.env.HOME || '/tmp'}/.localclaw`
        const dlDir = `${dataDir}/downloads`
        execSync(`mkdir -p "${dlDir}" && cp "${filePath}" "${dlDir}/"`, EXEC_OPTS)
        const fileName = path.basename(filePath)
        const dlUrl = `/downloads/${fileName}`
        return `Screenshot saved!\n  → http://localhost:${port}${dlUrl}`
      }

      onChunk?.(`Loading ${url} in headless browser...`)

      let script = ''
      if (waitSelector) {
        script = `(async () => { const el = await new Promise(resolve => { const fi = setInterval(() => { const e = document.querySelector('${waitSelector.replace(/'/g, "\\'")}'); if (e || (typeof fi === 'number' && clearInterval(fi) && false)) { clearInterval(fi); resolve(e); } }, 100); setTimeout(() => resolve(null), 10000); }); return el ? el.textContent : document.body.innerText; })()`
      }

      const html = await chromiumFetch(url, script)

      if (!html) return `Loaded ${url} but got empty response.`

      const clean = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[^;]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8000)

      if (!clean) return `Loaded ${url} but page had no visible text content.`
      return clean
    } catch (err: unknown) {
      return `Browser automation error: ${err instanceof Error ? err.message : String(err)}. Try using web_fetch instead.`
    }
  },
}
