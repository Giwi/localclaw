# Testing

Test runner: [Vitest](https://vitest.dev/) for server-side tests. Angular client uses Karma/Jasmine (`ng test`).

## Running tests

```bash
npm test              # vitest run (all tests)
npm test -- tests/db.test.ts    # single file
```

## Test files

| File | Lines | Coverage |
|------|-------|----------|
| `tests/db.test.ts` | 527 | Database schema, CRUD, search, embeddings, FTS5 |
| `tests/ollama.test.ts` | 203 | Ollama API client (chat + embedding endpoints) |
| `tests/weather.test.ts` | 175 | Weather tool: geocoding, API calls, forecast parsing |
| `tests/scheduler.test.ts` | 151 | Background scheduler: tick, parse, retry |
| `tests/agent.test.ts` | 130 | Agent loop: tool execution, streaming, failure modes |
| `tests/opencode.test.ts` | 110 | OpenCode CLI integration |
| `tests/log.test.ts` | 91 | Structured logger |
| `tests/auth.test.ts` | 90 | Bearer token middleware |
| `tests/sandbox.test.ts` | 76 | Docker sandbox wrapping |
| `tests/write-file.test.ts` | 70 | File writing with path validation |
| `tests/read-file.test.ts` | 50 | File reading with path validation |
| `tests/embeddings.test.ts` | 47 | Embedding API + cosine similarity |
| `tests/tools.test.ts` | 30 | Tool registry: register, list, dynamic |

## Writing tests

Tests use Vitest conventions:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('myModule', () => {
  it('does something', () => {
    const result = myFunction()
    expect(result).toBe('expected')
  })
})
```

### Mocking

- **Environment variables**: set before imports via `vi.stubEnv()` or direct assignment (tests run in sequence)
- **Network calls**: `vi.stubGlobal('fetch', mockFetch)` to mock the global fetch
- **Database**: create an in-memory SQLite instance: `new Database(':memory:')`
- **Module mocking**: `vi.mock()` for mocking external modules

### Existing test patterns

**Weather tool** (`tests/weather.test.ts`):
```ts
vi.stubGlobal('fetch', mockFetch)
const { weatherTool } = await import('../src/tools/builtin/weather.js')
const result = await weatherTool.execute({ location: 'Paris' })
```

**Database** (`tests/db.test.ts`):
```ts
const db = new Database(':memory:')
// run schema manually since openDb expects a path
```

## Known issues

- Weather tests 7 & 12 fail due to mock `res.text` not being stubbed — the mock only provides `res.json()` but the geocoding error path calls `res.text()`. Fix by adding `{ text: async () => 'error body' }` to the mock.
