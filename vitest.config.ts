import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['node_modules', 'dist', 'client'],
    include: ['tests/**/*.test.ts'],
  },
  server: {
    deps: {
      inline: ['better-sqlite3'],
    },
  },
})
