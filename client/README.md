# Client

Angular 20 SPA frontend for localclaw — an autonomous AI agent chat interface.

## Stack

- **Angular 20** with signals-based reactivity
- **Server-Sent Events** for real-time chat + tool output streaming
- **highlight.js** for code syntax highlighting (atom-one-dark theme)
- **Markdown rendering** with message formatting

## Project structure

```
client/src/app/
├── app.ts            # Main component — sessions, chat, tool event display
├── app.html          # Template — sidebar, chat area, tool cards
├── app.css           # Styles — cyberpunk theme, glass-morphism, light/dark
├── chat.service.ts   # API client — REST calls + SSE stream parsing
└── markdown.pipe.ts  # Markdown → HTML transform pipe
```

## Key concepts

- **Signals** (`signal()`, `update()`) manage all UI state — sessions list, current messages, tool events
- **SSE streaming** (`chat.service.ts:59-101`) uses raw `fetch()` + `ReadableStream` to parse `data:` events from `/api/sessions/:id/chat`
- **Session isolation** — chat subscriptions are automatically cleaned up when switching sessions to prevent cross-session response leakage
- **Tool events** are displayed as collapsible cards showing real-time progress (`tool_start` → `tool_chunk` → `tool_end`)

## Development

```bash
ng serve              # Dev server on http://localhost:4200 (proxied to :4173)
ng test               # Karma/Jasmine unit tests
```

The dev proxy is configured in `angular.json` under `proxyConfig` pointing to `proxy.conf.json`.

## Build

```bash
ng build              # Outputs to client/dist/browser/
```

The production build is served by the Express server at `/` (static files from `client/dist/browser/`).
