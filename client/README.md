# Client

Angular 20 SPA frontend for localclaw — an autonomous AI agent chat interface.

## Stack

- **Angular 20** with signals-based reactivity
- **WebSocket** for real-time chat streaming (was SSE, migrated to ws://)
- **Bootstrap 5.3** with custom CSS (plain CSS, no SCSS)
- **highlight.js** for code syntax highlighting (atom-one-dark theme)
- **Markdown rendering** via custom `MarkdownPipe`

## Project structure

```
client/src/app/
├── app.ts, app.html, app.config.ts    # Root component, Angular config
├── components/
│   ├── chat-area/                     # Main chat UI (messages, input, tool events)
│   ├── sidebar/                       # Session list + task sidebar with view switcher
│   ├── tasks-page/                    # Full-page task manager (details + execution logs)
│   └── weather-widget/                # Standalone weather card (reusable widget pattern)
├── services/
│   └── chat.service.ts                # HTTP client + WebSocket streaming + types
├── pipes/
│   └── markdown.pipe.ts               # Markdown → HTML transform pipe
└── styles.css                         # Global styles: light/dark themes, glass-morphism, components
```

## Key concepts

### Signals-based state
`signal()`, `update()`, `set()` manage all UI state:
- `sessions`, `messages`, `toolEvents` — chat state
- `backgroundTasks`, `loadingTasks` — task management
- `currentView` — switches between chat and tasks page
- `sidebarOpen`, `sidebarView`, `currentTheme` — UI controls

### WebSocket streaming (`chat.service.ts`)
- Connects to `ws://host/ws` and sends `{ type: 'chat', sessionId, message }`
- Receives JSON `StreamChunk` events: `text`, `tool_start`, `tool_chunk`, `tool_end`, `tool_error`, `status`, `done`, `error`
- `NgZone.run()` ensures change detection on WebSocket messages
- Cleanup on session switch (`cancelChat()`) closes the WebSocket to prevent cross-session leakage

### Tool events
Displayed as collapsible cards in the chat area:
- `tool_start` — spinning indicator with tool name
- `tool_chunk` — streaming output lines from tool execution
- `tool_end` — completion with collapsible result (expand to view full output)
- `tool_error` — error display in red

### Tool result persistence
`tool_end` events are stored as JSON in the `tool_results` column of the `messages` table. `reconstructToolEvents()` parses this on page reload so rendered widgets (weather, etc.) survive refresh.

### Weather widget
Rendered inline with the assistant message that produced it. Reads from `msg.toolResults` → `widget.data` (structured `ToolResult` pattern). Persisted on reload. See `components/weather-widget/` for the reusable component implementation.

### Tasks page
Full-page task manager accessible via the clock icon in the chat header:
- Left panel: task list with name, tool, schedule, status
- Right panel: selected task details (schedule, args, last result/error) + execution log table (last 20 runs)
- Pause/Resume, Run Now, Delete actions

### Message editing
Edit any user message via the "edit" link. The conversation is truncated after the edit point (server-side `PATCH /api/sessions/:id/messages/:msgId`), and a new agent response is generated.

### Themes
Light and dark themes via CSS custom properties (`:root` / `[data-theme="dark"]`). Auto-detection via `prefers-color-scheme`. Toggle persisted in `localStorage`.

### Proactive summary
On session load, calls `GET /api/sessions/:id/proactive` to check for upcoming scheduled tasks. Injects a greeting message if tasks exist.

### Input/Output
- File upload via paperclip icon (`.txt`, `.md`, `.pdf`, `.docx`)
- Drag-and-drop file upload with drop overlay
- Copy button on code blocks and tool results
- Stop generation button (closes WebSocket, aborts agent loop)
- 300-second loading timeout fallback
- Toast notifications for errors and confirmations

## Development

```bash
ng serve              # Dev server on http://localhost:4200 (proxied to :4173)
ng test               # Karma/Jasmine unit tests
```

The dev proxy is configured in `proxy.conf.js` (WebSocket upgrade proxied to backend).

## Build

```bash
ng build              # Outputs to client/dist/client/
```

The production build is served by the Express server at `/` (static files from `client/dist/client/browser/`).
