import { execSync } from 'child_process'
import type { ToolModule } from '../types.js'
import { log } from '../../log.js'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const OLLAMA_BASE = process.env.LOCALCLAW_OLLAMA_URL || 'http://localhost:11434'
const DATA_DIR = process.env.LOCALCLAW_DATA_DIR || path.join(process.env.HOME || '/tmp', '.localclaw')
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads')

export const generateImageTool: ToolModule = {
  definition: {
    name: 'generate_image',
    description: 'Generate an image using Ollama image models (flux, sd, stable-diffusion, etc.). Returns a URL to the generated image.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text description of the image to generate' },
        model: { type: 'string', description: 'Ollama model to use (e.g. flux, sd:latest). Default: flux' },
        size: { type: 'string', description: 'Image size (e.g. 1024x768). Default: 1024x1024' },
      },
      required: ['prompt'],
    },
  },
  execute: async (args) => {
    const prompt = (args.prompt || '').trim()
    const model = (args.model || 'flux') as string
    const size = (args.size || '1024x1024') as string

    if (!prompt) return 'Please provide a "prompt" parameter describing the image.'

    log.info(`generate_image: model=${model} size=${size} prompt="${prompt.slice(0, 80)}..."`)

    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true })

    const response = execSync(`curl -s -X POST ${OLLAMA_BASE}/api/generate -d '{
      "model": "${model}",
      "prompt": "${prompt.replace(/"/g, '\\"')}",
      "stream": false,
      "options": { "size": "${size}" }
    }'`, { encoding: 'utf-8', timeout: 120000 })

    const data = JSON.parse(response)

    if (data.response && data.response.startsWith('/')) {
      const src = data.response
      const ext = path.extname(src) || '.png'
      const name = crypto.randomUUID() + ext
      const dest = path.join(DOWNLOADS_DIR, name)
      execSync(`cp "${src}" "${dest}"`, { encoding: 'utf-8' })
      const port = process.env.LOCALCLAW_PORT || '4173'
      return `Image generated: http://localhost:${port}/downloads/${name}\nPrompt: ${prompt}`
    }

    if (data.response && data.response.length > 100) {
      const name = crypto.randomUUID() + '.png'
      const dest = path.join(DOWNLOADS_DIR, name)
      const base64 = data.response
      fs.writeFileSync(dest, Buffer.from(base64, 'base64'))
      const port = process.env.LOCALCLAW_PORT || '4173'
      return `Image generated: http://localhost:${port}/downloads/${name}\nPrompt: ${prompt}`
    }

    return `Image generation completed:\n${data.response || JSON.stringify(data).slice(0, 500)}`
  },
}
