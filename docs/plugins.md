# Plugins

Plugin system at `src/plugins.ts` — loads external tools from two directories at startup:

- `./plugins/` (project root)
- `<DATA_DIR>/plugins/` (e.g. `~/.localclaw/plugins/`)

Directories are auto-created if missing.

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
```

## Export interface

Files must export a `ToolModule` or a factory function returning one:

```typescript
interface ToolModule {
  definition: ToolDefinition
  execute: (args: Record<string, any>, onChunk?: (chunk: string) => void) => Promise<string>
}
```

**Plain object** — directly registered:

```javascript
export default {
  definition: {
    name: 'my_tool',
    description: 'Does something useful',
    parameters: { /* JSON Schema */ },
  },
  execute: async (args, onChunk) => {
    // ... do work ...
    return 'result'
  },
}
```

**Factory function** — receives no arguments, must return a `ToolModule`:

```javascript
export default function () {
  return {
    definition: { /* ... */ },
    execute: async (args, onChunk) => { /* ... */ },
  }
}
```

## Load order

1. Built-in tools are registered first (`src/tools/registry.ts:registerBuiltins()`)
2. DB-dependent tools (`schedule_task`, `search_knowledge`) are registered next (`src/index.ts`)
3. **Plugins are loaded last**, before the HTTP server starts

This means plugins can reference any previously registered tool.

## Error handling

Errors on individual plugins are logged as warnings and do not block startup. The server will start regardless of plugin failures.

```log
WARN  Failed to load plugin broken-tool.js: Cannot find module '...'
```
