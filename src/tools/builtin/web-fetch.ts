import { execSync, execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import type { ToolModule } from '../types.js'
import { log } from '../../log.js'

const HOME = process.env.HOME || '/tmp'
const DATA_DIR = process.env.LOCALCLAW_DATA_DIR || path.join(HOME, '.localclaw')
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads')

function ensureDownloadsDir() {
  if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true })
}

function extractImages(html: string): string[] {
  const urls: string[] = []
  const re = /<img[^>]+src=["']([^"']+)["']/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const src = m[1]
    if (src.startsWith('http') && !src.includes('icon') && !src.includes('logo') && !src.includes('pixel')) {
      urls.push(src)
    }
  }
  return urls.slice(0, 10)
}

function downloadFile(url: string, dir: string): { filePath: string; fileName: string; ext: string } | null {
  ensureDownloadsDir()
  const ext = path.extname(new URL(url).pathname).toLowerCase() || '.bin'
  const name = crypto.randomUUID() + ext
  const filePath = path.join(dir, name)
  try {
    execFileSync('curl', ['-sL', '--max-time', '30', '-o', filePath, url], { encoding: 'utf-8', timeout: 15000 })
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) return null
    return { filePath, fileName: name, ext }
  } catch { return null }
}

const FILE_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.zip', '.tar', '.gz', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.mp4', '.mp3', '.csv', '.json', '.xml', '.yaml', '.yml', '.md']
const SEARXNG_URL = process.env.LOCALCLAW_SEARXNG_URL || ''

async function searchSearxng(query: string, category: string = 'general'): Promise<string | null> {
  if (!SEARXNG_URL) {
    log.debug('SearXNG not configured, skipping')
    return null
  }
  try {
    const url = `${SEARXNG_URL}/search?format=json&q=${encodeURIComponent(query)}${category === 'images' ? '&categories=images' : ''}`
    log.sse(`SearXNG request: ${url}`)
    const out = execFileSync('curl', ['-sL', '--max-time', '10', '-H', 'Accept: application/json', url], { encoding: 'utf-8', timeout: 15000 }) as string
    const trimmed = out.trim()
    log.sse(`SearXNG response (${trimmed.length} chars): ${trimmed.slice(0, 200)}`)
    const data = JSON.parse(trimmed)
    const results = data.results || []
    if (results.length === 0) {
      log.sse('SearXNG returned 0 results')
      return null
    }
    log.sse(`SearXNG returned ${results.length} results`)

    if (category === 'images') {
      const urls = results.map((r: any) => r.img_src || r.thumbnail_src).filter(Boolean).slice(0, 10)
      if (urls.length > 0) return `Found ${urls.length} images:\n${urls.join('\n')}`
      // fallback: try extracting image URLs from regular result fields
      const imgUrls = results.map((r: any) => r.url).filter((u: string) => /\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(u)).slice(0, 10)
      if (imgUrls.length > 0) return `Found ${imgUrls.length} images:\n${imgUrls.join('\n')}`
      log.sse('Image category returned no image URLs')
      return null
    }

    const snippets = results.slice(0, 8).map((r: any, i: number) => {
      const title = r.title || 'Untitled'
      const content = (r.content || '').slice(0, 400)
      return `${i + 1}. ${title}\n   ${r.url}\n   ${content}`
    })
    return snippets.length > 0 ? `Search results for "${query}":\n\n${snippets.join('\n\n')}` : null
  } catch (err) {
    log.warn(`SearXNG search failed: ${err}`)
    return null
  }
}

export const webFetchTool: ToolModule = {
  definition: {
    name: 'web_fetch',
    description: 'Search the web or fetch a URL. Pass a search query or a full URL as "q". Use mode="images" to find pictures.',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search query (e.g. "latest news AI") or a full URL to fetch (e.g. "https://example.com"). Provide the actual search terms here.' },
        mode: { type: 'string', description: 'text for content, images for extracting image URLs, download to force file download', enum: ['text', 'images', 'download'] },
      },
      required: [],
    },
  },
  execute: async (args) => {
    const allArgs = JSON.stringify(args)
    const q = (args.q || args.url || args.search || args.query || args.text || '').trim()
    const mode = (args.mode || 'text') as string

    log.info(`web_fetch q="${q.slice(0, 100)}" mode=${mode} SEARXNG_URL=${SEARXNG_URL || 'not set'} args=${allArgs.slice(0, 200)}`)

    if (!q) {
      return `The "q" parameter was empty. Pass the search terms or URL as "q", e.g. q="what to search for". I received these args: ${allArgs.slice(0, 150)}`
    }

    const isUrl = q.startsWith('http://') || q.startsWith('https://')

    if (isUrl) {
      // Direct URL fetch
      return await fetchUrl(q, mode)
    }

    // Search query — use SearXNG or DuckDuckGo fallback
    if (SEARXNG_URL) {
      const searxngResult = await searchSearxng(q, mode === 'images' ? 'images' : 'general')
      if (searxngResult) return searxngResult
      return `No results found for "${q}". Try a different query.`
    }

    // Fallback: DuckDuckGo
    return await fetchUrl(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
      mode
    )
  },
}

async function fetchUrl(url: string, mode: string): Promise<string> {
  // Resolve domain — reject hallucinated URLs before any fetch
  let parsedUrl: URL
  try { parsedUrl = new URL(url) } catch {
    return `Invalid URL: "${url}".`
  }
  try {
    const hostname = parsedUrl.hostname
    let resolved = false
    for (const cmd of ['host', 'dig'] as const) {
      try {
        const args = cmd === 'host' ? [hostname] : ['+short', hostname]
        execFileSync(cmd, args, { encoding: 'utf-8', timeout: 5000 })
        resolved = true
        break
      } catch {}
    }
    if (!resolved) {
      return `Cannot resolve domain "${hostname}" — this domain does not exist.`
    }
  } catch {
    return `Cannot resolve domain "${parsedUrl.hostname}" — this domain does not exist.`
  }

  // Detect file downloads
  const ext = path.extname(parsedUrl.pathname).toLowerCase()
  const isFile = FILE_EXTENSIONS.includes(ext) || mode === 'download'

  if (isFile) {
    ensureDownloadsDir()
    const result = downloadFile(url, DOWNLOADS_DIR)
    if (!result) return `Failed to download ${url}.`
    const port = process.env.LOCALCLAW_PORT || '4173'
    const dlUrl = `/downloads/${result.fileName}`
    const isPdf = result.ext === '.pdf'
    const viewHint = isPdf ? `\nTo view it: http://localhost:${port}${dlUrl}` : ''
    return `Downloaded ${url}\n  → ${result.filePath}${viewHint}\nFile type: ${result.ext || 'unknown'} (${(fs.statSync(result.filePath).size / 1024).toFixed(1)} KB)`
  }

  try {
    const html = (execFileSync('curl', ['-sL', '--max-time', '15', '-A', 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0', url], { encoding: 'utf-8', timeout: 15000 }) as string).trim()
    if (!html) return `Fetched ${url} but got empty response.`

    if (mode === 'images') {
      const images = extractImages(html)
      if (images.length > 0) return `Found ${images.length} images:\n${images.join('\n')}`
      return `No images found at ${url}.`
    }

    const clean = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[^;]+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000)

    if (!clean) return `Fetched ${url} but content was empty after cleaning.`

    const images = extractImages(html)
    const imgSection = images.length > 0 ? `\n\nImages found:\n${images.join('\n')}` : ''
    return `${clean}${imgSection}`
  } catch (err: unknown) {
    const errm = err instanceof Error ? err.message : String(err)
    if (SEARXNG_URL) {
      return `Failed to fetch ${url}. Error: ${errm}`
    }
    try {
      const fallback = (execFileSync('curl', ['-sL', '--max-time', '10', `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(url)}`], { encoding: 'utf-8', timeout: 15000 }) as string).trim()
      return fallback.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000) || `Failed to fetch ${url}: ${errm}`
    } catch {
      return `Failed to fetch ${url}: ${errm}`
    }
  }
}
