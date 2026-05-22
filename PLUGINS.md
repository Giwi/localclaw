# Plugins

localclaw supports loading external tools as plugins from `.js` or `.mjs` files.

## Plugin directories

Plugins are scanned from two locations:

1. `<project>/plugins/` — bundled with the project
2. `<dataDir>/plugins/` — user-installed (`~/.localclaw/plugins/`)

## Plugin format

A plugin file exports a tool module conforming to the `ToolModule` interface:

```js
// my-tool.js
export default {
  definition: {
    name: 'my_tool',
    description: 'Description of what the tool does.',
    parameters: {
      type: 'object',
      properties: {
        param1: { type: 'string', description: 'First parameter' },
      },
      required: ['param1'],
    },
  },
  execute: async (args, onChunk) => {
    onChunk?.('Working...')
    // ... do work ...
    return { result: 'Text for Ollama', widget: { type: 'my_widget', data: { key: 'value' } } }
  },
}
```

### ToolResult (dual response)

Tools can return either a plain `string` (text for the LLM) or a `ToolResult` object:

```js
{
  result: 'Text the LLM reads and reasons about',
  widget?: {
    type: 'my_widget',       // matches a frontend widget component
    data: { ... }            // structured data for the widget
  }
}
```

The `result` is passed to the LLM as before. The optional `widget` carries structured data that the frontend renders directly (e.g. weather card, search results, image gallery) — no string parsing needed.

### NPM package plugins

Plugins can also be directories containing a `package.json` with a `main` entry:

```
plugins/
  my-plugin/
    package.json    # { "main": "index.js" }
    index.js        # exports ToolModule
    node_modules/   # dependencies
```

## Generating tools on the fly

Instead of shipping domain-specific tools as builtins, let the LLM generate them via `create_tool` at runtime. For example, a TV guide tool can be created on demand:

> User: "Qu'est-ce qu'il y a à la télé ce soir ?"
> Agent: [calls create_tool to dynamically build a js tool that fetches TVMaze API]

This keeps the core lean — tools that are only needed occasionally are created when asked.

## Built-in tools as templates

The built-in tools in `src/tools/builtin/` serve as reference implementations for the plugin pattern. Each demonstrates:

- **web-fetch** — fetching external APIs with `User-Agent` headers, timeout handling
- **weather** — returning a `ToolResult` with a widget for rich frontend rendering
- **read-file / write-file** — filesystem access with path validation
- **run-bash** — command execution with streaming output via `onChunk`
- **send-telegram / send-email** — external service integration

Use them as templates when writing your own plugins.

## Plugin lifecycle

1. **Startup** — `plugins.ts` scans both plugin directories on server start
2. **Registration** — each valid plugin is added to the `ToolRegistry`
3. **Discovery** — the LLM sees the tool in the system prompt's tool list
4. **Execution** — when called, the plugin runs with the agent's sandbox rules

Plugins are re-scanned on each server restart. No hot-reload — restart the server to pick up new or changed plugins.

## Example: TV guide plugin

A complete example of a plugin that fetches French TV listings and sends them via Telegram:

```js
// plugins/french-tv-guide.js
const BOT_TOKEN = process.env.LOCALCLAW_TELEGRAM_BOT_TOKEN
const CHAT_ID = process.env.LOCALCLAW_TELEGRAM_CHAT_ID || ''

export default {
  definition: {
    name: 'french_tv_guide',
    description: 'Get tonight\'s TV guide for France (18:00-23:00) from TVMaze. Set send_telegram="true" to deliver via Telegram.',
    parameters: {
      type: 'object',
      properties: {
        send_telegram: { type: 'string', description: 'Set to "true" to send to Telegram', enum: ['true', 'false'] },
      },
      required: [],
    },
  },
  execute: async (args, onChunk) => {
    onChunk?.('Fetching TV schedule...')
    const today = new Date().toISOString().split('T')[0]
    const res = await fetch(`https://api.tvmaze.com/schedule?country=FR&date=${today}`)
    const data = await res.json()
    const lines = data
      .filter(e => e.airtime && e.show && parseInt(e.airtime) >= 18)
      .sort((a, b) => a.airtime.localeCompare(b.airtime))
      .map(e => `${e.airtime} — ${e.show.network?.name || '?'} : ${e.show.name}`)

    const text = `TV Guide — ${today}\n\n${lines.join('\n')}`

    if (args.send_telegram === 'true' && BOT_TOKEN && CHAT_ID) {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown' }),
      })
      return { result: text + '\n\nSent to Telegram', widget: { type: 'tv_guide', data: { date: today, channels: data } } }
    }

    return { result: text }
  },
}
```

## Registering built-in tools

To add a new built-in tool (shipped with the app, not user-installed):

1. Create `src/tools/builtin/<name>.ts` exporting a `ToolModule`
2. Import and add to the array in `src/tools/registry.ts` → `registerBuiltins()`
3. If it needs DB access, use a factory function `createXTool(db)` and register in `src/index.ts`

## Debugging

Set `LOCALCLAW_LOG_LEVEL=debug` to see plugin scan output and tool execution details in the server logs. Failed plugin loads are logged at `warn` level.
