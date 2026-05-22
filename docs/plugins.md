# Plugins

Plugin system at `src/plugins.ts` — loads external tools from two directories at startup:

- `./plugins/` (project root)
- `<DATA_DIR>/plugins/` (e.g. `~/.localclaw/plugins/`)

Directories are auto-created if missing.

## Load order

1. Built-in tools are registered first (`src/tools/registry.ts:registerBuiltins()`)
2. DB-dependent tools (`schedule_task`, `search_knowledge`) are registered next (`src/index.ts`)
3. **Plugins are loaded last**, before the HTTP server starts

Plugins are re-scanned on each server restart. No hot-reload.

## Supported formats

### Single file

Any `.js` or `.mjs` file directly in the plugins directory:

```
plugins/
  my-tool.js
  my-other-tool.mjs
```

### Directory package

Subdirectory with a `package.json`; loaded via its `main` field (defaults to `index.js`):

```
plugins/
  my-tool/
    package.json
    index.js
    node_modules/   # dependencies
```

## Export interface

A plugin file must export a `ToolModule` or a factory function returning one:

### Plain object

```js
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
    return { result: 'Text for Ollama', widget: { type: 'my_widget', data: {} } }
  },
}
```

### Factory function

```js
export default function () {
  return {
    definition: { /* ... */ },
    execute: async (args, onChunk) => { /* ... */ },
  }
}
```

## ToolResult (dual response)

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

The `result` is passed to the LLM as before. The optional `widget` carries structured data that the frontend renders directly as a native component (e.g. weather card, search results, image gallery) — no fragile string parsing needed.

## Plugin lifecycle

1. **Startup** — `plugins.ts` scans both plugin directories on server start
2. **Registration** — each valid plugin is added to the `ToolRegistry`
3. **Discovery** — the LLM sees the tool in the system prompt's tool list
4. **Execution** — when called, the plugin runs with the agent's sandbox rules

## Error handling

Errors on individual plugins are logged as warnings and do not block startup. The server will start regardless of plugin failures.

```
WARN  Failed to load plugin broken-tool.js: Cannot find module '...'
```

## Generative tools vs built-ins

Instead of shipping domain-specific tools as builtins, let the LLM generate them via `create_tool` at runtime. For example, a TV guide tool can be created on demand:

> User: "What's on TV tonight?"
> Agent: [calls `create_tool` to dynamically build a JS tool that fetches TVMaze API]

This keeps the core lean — tools that are only needed occasionally are created when asked.

## Built-in tools as templates

The built-in tools in `src/tools/builtin/` serve as reference implementations for the plugin pattern:

- **web-fetch** — fetching external APIs with `User-Agent` headers, timeout handling
- **weather** — returning a `ToolResult` with a `widget` for rich frontend rendering
- **read-file / write-file** — filesystem access with path validation
- **run-bash** — command execution with streaming output via `onChunk`
- **send-telegram / send-email** — external service integration

## Example: TV guide plugin

A complete example that fetches French TV listings and optionally sends them via Telegram:

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
      return {
        result: text + '\n\nSent to Telegram',
        widget: { type: 'tv_guide', data: { date: today, lines } },
      }
    }

    return { result: text }
  },
}
```

## Registering built-in tools

To add a new built-in tool (shipped with the app):

1. Create `src/tools/builtin/<name>.ts` exporting a `ToolModule`
2. Import and add to the array in `src/tools/registry.ts` → `registerBuiltins()`
3. If it needs DB access, use a factory function `createXTool(db)` and register in `src/index.ts`

## Debugging

Set `LOCALCLAW_LOG_LEVEL=debug` to see plugin scan output and tool execution details in the server logs. Failed plugin loads are logged at `warn` level.
