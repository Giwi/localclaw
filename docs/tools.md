# Tools

How tools power the agent loop — from built-in registrations to the dual-response widget pattern.

## How tools work

1. The system prompt lists all available tools with their names, parameters, and descriptions
2. Ollama decides when to call a tool and includes `tool_calls` in its response
3. The agent loop executes the tool, streams chunks to the client, and feeds the result back
4. Ollama sees the tool result and decides the next step (another tool call or final text)

## Writing a tool

A tool is a `ToolModule` with a `definition` and an `execute` function:

```typescript
interface ToolModule {
  definition: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, ToolParameter>
      required: string[]
    }
    code?: string      // for create_tool — the tool's source code
    language?: 'javascript' | 'python' | 'bash'
  }
  execute: (
    args: Record<string, any>,
    onChunk?: (chunk: string) => void
  ) => Promise<string | ToolResult>
}
```

### onChunk callback

Use `onChunk?.(message)` to stream progress updates to the client during long-running tool execution:

```ts
execute: async (args, onChunk) => {
  onChunk?.('Step 1/3: Fetching data...')
  const data = await fetch(...)
  onChunk?.('Step 2/3: Processing...')
  // ...
  onChunk?.('Step 3/3: Done')
  return result
}
```

Chunks appear as `tool_chunk` events in the client's tool card.

### Error handling

Throw errors or return error strings — both are caught by the agent loop and surfaced as `tool_error` events:

```ts
try {
  const res = await fetch(url)
  if (!res.ok) return `API error: ${res.status}`
  return await res.text()
} catch (err) {
  return `Failed: ${err instanceof Error ? err.message : String(err)}`
}
```

## ToolResult (dual response)

Tools can return a `ToolResult` object instead of a plain string. This enables rich frontend rendering without fragile string parsing:

```ts
interface ToolResult {
  result: string        // Text for the LLM to read and reason about
  widget?: ToolWidget   // Structured data for the frontend
}

interface ToolWidget {
  type: string          // Matches a widget component name
  data: Record<string, unknown>
}
```

The `result` string is what the LLM sees — keep it informative. The optional `widget` is what the user sees.

### Example: weather tool

```ts
execute: async (args, onChunk) => {
  const data = await fetchWeatherAPI(args.location)

  return {
    // LLM reads this to answer follow-up questions
    result: `Weather for ${data.city}: ${data.temp}°C, ${data.condition}`,
    // Frontend renders this as a card
    widget: {
      type: 'weather',
      data: {
        city: data.city,
        currentTemp: data.temp,
        condition: data.condition,
        forecast: data.forecast,
      },
    },
  }
}
```

### Creating a widget component

1. Create a component in `client/src/app/components/<widget-name>/`
2. Accept `@Input() data` matching the widget's data shape
3. Register it in the parent component's `imports` array
4. Render with `<app-widget-name [data]="widgetData"></app-widget-name>`

See `components/weather-widget/` for the reference implementation.

## Built-in tools

### web_fetch
Search the web (SearXNG or DuckDuckGo) or fetch a specific URL. Supports text, images, and download modes.

| Param | Type | Description |
|-------|------|-------------|
| `query` | string | Search query or URL |
| `mode` | string | `text`, `images`, or `download` |

### fetch_news
Fetch latest news articles via SearXNG news search or RSS fallback.

| Param | Type | Description |
|-------|------|-------------|
| `query` | string | Topic to search for |
| `limit` | string | Max results (default 5) |

### weather
Get current weather and forecast for any location via Open-Meteo (returns a `ToolResult` with widget).

| Param | Type | Description |
|-------|------|-------------|
| `location` | string | City name or "lat,lon" coordinates |
| `days` | string | Forecast days 1-7 (default 3) |

### read_file / write_file
Read and write local files with path traversal protection.

| Param | Type | Description |
|-------|------|-------------|
| `path` | string | File path (relative to data dir) |
| `content` | string | (write_file only) File contents |

### run_bash
Execute bash commands with real-time streaming output. Blocked commands: `rm -rf /`, `mkfs`, `dd if=`, fork bombs.

| Param | Type | Description |
|-------|------|-------------|
| `command` | string | Bash command to execute |
| `workdir` | string | Working directory |

### opencode_task
Delegate complex multi-file coding tasks to [OpenCode](https://opencode.ai).

| Param | Type | Description |
|-------|------|-------------|
| `prompt` | string | Task description for OpenCode |

### generate_image
Generate images using Ollama image models (flux, sd, etc.). Saves to downloads dir.

| Param | Type | Description |
|-------|------|-------------|
| `prompt` | string | Image description |
| `model` | string | Model name (defaults to env or flux) |

### send_email
Send email via Mailgun API.

| Param | Type | Description |
|-------|------|-------------|
| `to` | string | Recipient email |
| `subject` | string | Email subject |
| `body` | string | Email body (plain text or HTML) |

### send_telegram
Send Telegram messages via bot. If `LOCALCLAW_TELEGRAM_CHAT_ID` is set in env, `chat_id` can be omitted.

| Param | Type | Description |
|-------|------|-------------|
| `text` | string | Message text |
| `chat_id` | string | Target chat ID (optional if env var set) |

### schedule_task
Schedule, list, and unschedule background tasks.

| Param | Type | Description |
|-------|------|-------------|
| `action` | string | `schedule`, `list`, or `unschedule` |
| `name` | string | Task name |
| `schedule` | string | `every Xm`, `every Xh`, `daily at HH:MM`, `daily`, `weekly` |
| `tool` | string | Tool to run |
| `args` | string | JSON string of tool arguments |

### search_knowledge
Search the RAG knowledge base (uploaded documents + past tool results).

| Param | Type | Description |
|-------|------|-------------|
| `query` | string | Search query |
| `mode` | string | `keyword` or `semantic` |

### browser_automation
Control a headless Chromium browser via Puppeteer.

| Param | Type | Description |
|-------|------|-------------|
| `action` | string | `navigate`, `click`, `extract`, `screenshot`, `fill` |
| `url` | string | URL to navigate to |
| `selector` | string | CSS selector for click/extract/fill |

### create_tool
Dynamically create new reusable tools in JavaScript, Python, or Bash.

| Param | Type | Description |
|-------|------|-------------|
| `name` | string | Unique tool name |
| `description` | string | What the tool does |
| `code` | string | Tool source code |
| `language` | string | `javascript`, `python`, or `bash` |
| `parameters` | string | JSON Schema for tool parameters |

## Registering tools

**Built-in** (shipped with the app):
1. Create `src/tools/builtin/<name>.ts` exporting a `ToolModule`
2. Add to the array in `src/tools/registry.ts` → `registerBuiltins()`

**DB-dependent** (needs database access):
1. Export a factory `createXTool(db: Database): ToolModule`
2. Register in `src/index.ts` via `registry.register(name, tool)`

**Plugin** (user-installed):
1. Drop a `.js` file in `plugins/` or `~/.localclaw/plugins/`
2. Exports a `ToolModule` or a factory function
3. Loaded automatically on next restart
4. See [docs/plugins.md](plugins.md) for the full plugin format
