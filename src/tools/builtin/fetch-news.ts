import { execSync } from 'child_process'
import type { ExecSyncOptions } from 'child_process'
import type { ToolModule } from '../types.js'
import { log } from '../../log.js'

const EXEC_OPTS: ExecSyncOptions = { encoding: 'utf-8', timeout: 15000, shell: '/bin/bash' }
const SEARXNG_URL = process.env.LOCALCLAW_SEARXNG_URL || ''

interface NewsItem {
  title: string
  url: string
  source: string
  snippet: string
  published?: string
}

async function searchSearxngNews(query: string): Promise<NewsItem[] | null> {
  if (!SEARXNG_URL) return null
  try {
    const url = `${SEARXNG_URL}/search?format=json&q=${encodeURIComponent(query)}&categories=news&pageno=1`
    log.sse(`SearXNG news: ${url}`)
    const out = execSync(`curl -sL --max-time 10 -H "Accept: application/json" "${url}"`, EXEC_OPTS) as string
    const data = JSON.parse(out.trim())
    const results = data.results || []
    if (results.length === 0) return null
    return results.slice(0, 10).map((r: any) => ({
      title: r.title || 'Untitled',
      url: r.url || '',
      source: r.engine || r.source || 'news',
      snippet: (r.content || '').slice(0, 300),
      published: r.publishedDate || undefined,
    }))
  } catch (err) {
    log.warn(`SearXNG news search failed: ${err}`)
    return null
  }
}

function fetchRss(url: string): NewsItem[] {
  try {
    const xml = execSync(`curl -sL --max-time 10 "${url}"`, EXEC_OPTS) as string
    const items: NewsItem[] = []
    const itemRegex = /<item>[\s\S]*?<\/item>/gi
    let m: RegExpExecArray | null
    while ((m = itemRegex.exec(xml)) !== null) {
      const item = m[0]
      const title = (item.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [,''])[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
      const link = (item.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [,''])[1].trim()
      const desc = (item.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [,''])[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
      const pubDate = (item.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [,''])[1].trim()
      if (title && link) {
        items.push({ title, url: link, source: new URL(url).hostname, snippet: desc, published: pubDate || undefined })
      }
    }
    return items
  } catch { return [] }
}

const RSS_FEEDS: { name: string; url: string }[] = [
  { name: 'Reuters Top News', url: 'https://www.rss-bridge.org/bridge01/?action=display&bridge=FilterBridge&url=https%3A%2F%2Fwww.reuters.com%2F&content_filter=article&content_filter_type=uri&inverse=on&case_insensitive=on&format=Atom' },
  { name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
]

export const fetchNewsTool: ToolModule = {
  definition: {
    name: 'fetch_news',
    description: 'Fetch the latest news articles on any topic. Returns article titles, sources, URLs, and summaries. Use this for staying up-to-date with current events, tech news, or any specific topic.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'News topic or keyword to search for (e.g. "technology", "AI", "world news", "sports"). Leave empty for top headlines.' },
        source: { type: 'string', description: 'Optional: prefer results from a specific source (e.g. "reuters", "bbc", "techcrunch")' },
        max_results: { type: 'string', description: 'Maximum number of articles to return (default: 8)' },
      },
      required: [],
    },
  },
  execute: async (args, onChunk) => {
    const topic = (args.topic || args.query || args.q || '').trim()
    const preferSource = (args.source || '').trim().toLowerCase()
    const maxResults = parseInt(args.max_results || '8', 10) || 8

    let allNews: NewsItem[] = []

    // 1. Try SearXNG news search
    if (topic) {
      onChunk?.(`Searching news for "${topic}"...`)
      const searxng = await searchSearxngNews(topic)
      if (searxng) allNews.push(...searxng)
    } else {
      onChunk?.('Fetching latest headlines...')
      // No topic: fetch from RSS feeds
      for (const feed of RSS_FEEDS) {
        const items = fetchRss(feed.url)
        if (items.length > 0) {
          allNews.push(...items)
          log.agent(`News RSS "${feed.name}": ${items.length} items`)
        }
      }
    }

    // 2. Fallback: if SearXNG not configured or returned nothing, use RSS
    if (allNews.length === 0) {
      if (!SEARXNG_URL) {
        onChunk?.('Search engine not configured, falling back to RSS feeds...')
        for (const feed of RSS_FEEDS) {
          const items = fetchRss(feed.url)
          if (items.length > 0) allNews.push(...items)
        }
      }
      // If still nothing, try direct web search via DuckDuckGo
      if (allNews.length === 0) {
        const query = topic || 'latest news'
        onChunk?.(`Searching web for "${query}"...`)
        try {
          const html = (execSync(`curl -sL --max-time 10 "https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}"`, EXEC_OPTS) as string).trim()
          const resultRegex = /<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/gi
          const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
          const urlRegex = /<a[^>]+class="result__url"[^>]*>([\s\S]*?)<\/a>/gi
          const titles = [...html.matchAll(resultRegex)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean)
          const snippets = [...html.matchAll(snippetRegex)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean)
          const urls = [...html.matchAll(urlRegex)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean)

          for (let i = 0; i < Math.min(titles.length, 10); i++) {
            allNews.push({
              title: titles[i] || 'Untitled',
              url: urls[i] || '',
              source: urls[i] ? new URL(urls[i]).hostname : 'web',
              snippet: snippets[i]?.slice(0, 300) || '',
            })
          }
        } catch { /* give up */ }
      }
    }

    // Apply source filter if requested
    if (preferSource && allNews.length > 0) {
      const filtered = allNews.filter((n) => n.source.includes(preferSource))
      if (filtered.length > 0) allNews = filtered
    }

    // Deduplicate by URL
    const seen = new Set<string>()
    allNews = allNews.filter((n) => {
      if (seen.has(n.url)) return false
      seen.add(n.url)
      return true
    })

    if (allNews.length === 0) {
      if (topic) return `No news found for "${topic}". Try a different topic.`
      return 'Unable to fetch news at this time. Check that SearXNG is running or try a specific topic.'
    }

    // Sort: prefer articles with published dates
    allNews.sort((a, b) => {
      if (a.published && b.published) return new Date(b.published).getTime() - new Date(a.published).getTime()
      if (a.published) return -1
      if (b.published) return 1
      return 0
    })

    const header = topic ? `Latest news for "${topic}":` : 'Latest headlines:'
    const articles = allNews.slice(0, maxResults).map((n, i) => {
      const date = n.published ? ` (${new Date(n.published).toLocaleDateString()})` : ''
      return `${i + 1}. ${n.title}${date}\n   Source: ${n.source}\n   ${n.url}\n   ${n.snippet}`
    })

    return `${header}\n\n${articles.join('\n\n')}`
  },
}
