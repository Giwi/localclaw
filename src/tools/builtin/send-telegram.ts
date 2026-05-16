import type { ToolModule } from '../types.js'
import { log } from '../../log.js'

const BOT_TOKEN = process.env.LOCALCLAW_TELEGRAM_BOT_TOKEN
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`

export const sendTelegramTool: ToolModule = {
  definition: {
    name: 'send_telegram',
    description: `Send a message via Telegram bot. Use this to deliver alerts, notifications, or any content to a Telegram user or group.

To find your chat_id:
1. Start a conversation with @giwi_local_claw_bot on Telegram
2. Send any message to the bot
3. Then use this tool with action="get_chat_id"
4. Use the returned chat_id in future messages`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '"send" to send a message, "get_chat_id" to check for recent interactions', enum: ['send', 'get_chat_id'] },
        chat_id: { type: 'string', description: 'Telegram chat ID (required for action=send). Can be a number or @username.' },
        text: { type: 'string', description: 'Message text to send (required for action=send). Supports Markdown: *bold*, _italic_, `code`.' },
        parse_mode: { type: 'string', description: 'Optional: "Markdown" or "HTML" for formatted messages', enum: ['Markdown', 'HTML'] },
      },
      required: ['action'],
    },
  },
  execute: async (args, onChunk) => {
    if (!BOT_TOKEN) {
      return 'Telegram bot token not configured. Set LOCALCLAW_TELEGRAM_BOT_TOKEN in .env'
    }

    const action = args.action as string

    if (action === 'get_chat_id') {
      onChunk?.('Checking for recent Telegram interactions...')
      try {
        const res = await fetch(`${API_BASE}/getUpdates`, {
          signal: AbortSignal.timeout(10000),
        })
        const data = await res.json()
        if (!data.ok) return `Telegram API error: ${data.description || 'unknown'}`

        const results = data.result || []
        if (results.length === 0) {
          return `No recent interactions found. To get your chat_id:
1. Open Telegram and search for @giwi_local_claw_bot
2. Start a conversation and send any message
3. Run this tool again with action=get_chat_id

Alternatively, if you already know your chat_id, you can use it directly in send_telegram with action=send.`
        }

        const chats = new Map<string, { type: string; title: string }>()
        for (const update of results) {
          const msg = update.message || update.my_chat_member?.chat
          if (!msg) continue
          const chat = msg.chat
          const key = String(chat.id)
          if (!chats.has(key)) {
            chats.set(key, { type: chat.type, title: chat.title || chat.first_name || chat.username || 'Unknown' })
          }
        }

        const lines = Array.from(chats.entries()).map(
          ([id, info]) => `- ${info.title} (${info.type}): chat_id = ${id}`
        )
        return `Found ${chats.size} chat(s):\n${lines.join('\n')}\n\nUse the chat_id with send_telegram({action:"send", chat_id:"...", text:"..."})`
      } catch (err: any) {
        return `Failed to fetch updates: ${err.message}`
      }
    }

    if (action === 'send') {
      const chatId = (args.chat_id || '').trim()
      const text = (args.text || '').trim()
      const parseMode = args.parse_mode as string || ''

      if (!chatId) return 'Please provide a "chat_id" (use action=get_chat_id first).'
      if (!text) return 'Please provide a "text" message to send.'

      onChunk?.(`Sending Telegram message to ${chatId}...`)

      const body: Record<string, string> = { chat_id: chatId, text }
      if (parseMode) body.parse_mode = parseMode

      try {
        const res = await fetch(`${API_BASE}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        })
        const data = await res.json()
        if (data.ok) {
          const msgId = data.result?.message_id
          onChunk?.('Message sent!')
          log.agent(`Telegram message sent to ${chatId} (msg_id: ${msgId})`)
          return `Message sent successfully to ${chatId} (message_id: ${msgId})`
        } else {
          let hint = data.description || 'unknown error'
          if (data.description?.includes('chat not found')) {
            hint += `\nTip: The user must start a conversation with @giwi_local_claw_bot first, then use action=get_chat_id to get their chat_id.`
          }
          return `Failed to send: ${hint}`
        }
      } catch (err: any) {
        return `Telegram API error: ${err.message}`
      }
    }

    return `Unknown action "${action}". Use "send" or "get_chat_id".`
  },
}
