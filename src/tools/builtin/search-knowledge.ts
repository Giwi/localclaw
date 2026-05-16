import type { ToolModule } from '../types.js'
import type BetterSqlite3 from 'better-sqlite3'
import { searchKnowledge } from '../../db.js'
import { embed } from '../../embeddings.js'

export function createSearchKnowledgeTool(db: BetterSqlite3.Database): ToolModule {
  return {
    definition: {
      name: 'search_knowledge',
      description: 'Search uploaded documents (PDFs, text files, markdown) by semantic meaning. Use this to find information from files the user has uploaded to their knowledge base.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query — what you want to find in the documents' },
          limit: { type: 'string', description: 'Maximum number of results (default: 5)' },
        },
        required: ['query'],
      },
    },
    execute: async (args) => {
      const query = (args.query || '').trim()
      const limit = parseInt(args.limit || '5', 10) || 5

      if (!query) return 'Please provide a "query" to search for.'

      try {
        const queryEmb = await embed(query)
        if (!queryEmb || queryEmb.length === 0) return 'Failed to generate embedding for query.'

        const results = searchKnowledge(db, queryEmb, limit)
        if (results.length === 0) {
          return 'No matching documents found. The user may not have uploaded any files yet, or the query did not match any content.'
        }

        const lines = results.map((r, i) => {
          const doc = r.documentName ? `[from: ${r.documentName}]` : ''
          return `${i + 1}. ${doc} (relevance: ${(r.score * 100).toFixed(0)}%)\n   ${r.content.slice(0, 400)}`
        })

        return `Found ${results.length} relevant excerpt(s):\n\n${lines.join('\n\n')}`
      } catch (err: any) {
        return `Knowledge search failed: ${err.message}`
      }
    },
  }
}
