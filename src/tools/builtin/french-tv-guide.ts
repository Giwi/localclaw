import type { ToolModule } from '../types.js'
import { log } from '../../log.js'

const BOT_TOKEN = process.env.LOCALCLAW_TELEGRAM_BOT_TOKEN
const DEFAULT_CHAT_ID = process.env.LOCALCLAW_TELEGRAM_CHAT_ID || ''
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

const TVMAZE_API = 'https://api.tvmaze.com/schedule?country=FR'

interface TvEntry {
  time: string
  channel: string
  title: string
  runtime: number | null
}

async function fetchTvGuide(): Promise<TvEntry[]> {
  const today = new Date().toISOString().split('T')[0]
  const url = `${TVMAZE_API}&date=${today}`

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`TVMaze API error ${res.status}`)

  const data: { airtime?: string; runtime?: number | null; show?: { name?: string; network?: { name?: string }; webChannel?: { name?: string } } }[] = await res.json()

  const entries: TvEntry[] = []
  for (const item of data) {
    if (!item.airtime || !item.show) continue
    const hour = parseInt(item.airtime.split(':')[0], 10)
    if (hour < 18 || hour > 23) continue

    entries.push({
      time: item.airtime,
      channel: item.show.network?.name || item.show.webChannel?.name || '?',
      title: item.show.name || '?',
      runtime: item.runtime || null,
    })
  }

  entries.sort((a, b) => a.time.localeCompare(b.time))
  return entries
}

function formatTvGuide(entries: TvEntry[]): string {
  if (entries.length === 0) {
    return '*Programme TV — France*\n\nAucun programme trouvé pour ce soir.'
  }

  const lines = entries.map((e) => {
    const r = e.runtime ? ` (${e.runtime} min)` : ''
    return `${e.time} — *${e.channel}* : ${e.title}${r}`
  })

  const dateStr = new Date().toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  return `📺 *Programme TV du soir — ${dateStr}*\n\n${lines.join('\n')}`
}

async function sendTelegram(text: string, onChunk?: (chunk: string) => void): Promise<string> {
  if (!BOT_TOKEN) return '❌ LOCALCLAW_TELEGRAM_BOT_TOKEN non configuré'
  if (!DEFAULT_CHAT_ID) return '❌ LOCALCLAW_TELEGRAM_CHAT_ID non configuré'

  onChunk?.('Envoi sur Telegram...')

  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: DEFAULT_CHAT_ID,
      text,
      parse_mode: 'Markdown',
    }),
    signal: AbortSignal.timeout(15000),
  })

  const data = await res.json()
  if (data.ok) {
    log.agent('TV guide sent to Telegram')
    return '✅ Programme TV envoyé sur Telegram'
  }

  log.agent(`Telegram send failed: ${data.description}`)
  return `❌ Échec envoi Telegram : ${data.description || 'erreur inconnue'}`
}

export const frenchTvGuideTool: ToolModule = {
  definition: {
    name: 'french_tv_guide',
    description: `Récupère le programme TV du soir en France (18h-23h) depuis TVMaze.

Utilise send_telegram="true" pour envoyer le résultat sur Telegram.

Exemples d'utilisation :
- Agent : appeler sans argument pour voir le programme dans le chat
- Tâche planifiée : {"send_telegram":"true"} pour recevoir le programme automatiquement sur Telegram chaque soir`,
    parameters: {
      type: 'object',
      properties: {
        send_telegram: {
          type: 'string',
          description: 'Mettre à "true" pour envoyer le programme sur Telegram (par défaut: false)',
          enum: ['true', 'false'],
        },
      },
      required: [],
    },
  },
  execute: async (args, onChunk) => {
    onChunk?.('Récupération du programme TV...')

    let entries: TvEntry[]
    try {
      entries = await fetchTvGuide()
    } catch (err: unknown) {
      return `❌ Erreur lors de la récupération du programme TV : ${err instanceof Error ? err.message : String(err)}`
    }

    const formatted = formatTvGuide(entries)
    const sendFlag = args.send_telegram === 'true'

    if (!sendFlag) return formatted

    const sendResult = await sendTelegram(formatted, onChunk)
    return `${formatted}\n\n${sendResult}`
  },
}
