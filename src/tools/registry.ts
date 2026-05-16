import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import type { ExecSyncOptions } from 'child_process'

const EXEC_OPTS = { encoding: 'utf-8' as const, timeout: 30000, shell: '/bin/bash' }
import type { ToolDefinition, ToolModule } from './types.js'
import { readFileTool } from './builtin/read-file.js'
import { writeFileTool } from './builtin/write-file.js'
import { runBashTool } from './builtin/run-bash.js'
import { opencodeTaskTool } from './builtin/opencode-task.js'
import { webFetchTool } from './builtin/web-fetch.js'
import { generateImageTool } from './builtin/generate-image.js'
import { sendEmailTool } from './builtin/send-email.js'
import { sendTelegramTool } from './builtin/send-telegram.js'
import { fetchNewsTool } from './builtin/fetch-news.js'
import { wrapCommand, isSandboxAvailable } from './sandbox.js'

export class ToolRegistry {
  private tools = new Map<string, ToolModule>()
  private toolsDir: string

  constructor(dataDir: string) {
    this.toolsDir = path.join(dataDir, 'tools')
    fs.mkdirSync(this.toolsDir, { recursive: true })
    this.registerBuiltins()
    this.loadPersisted()
  }

  private registerBuiltins() {
    for (const tool of [
      readFileTool,
      writeFileTool,
      runBashTool,
      webFetchTool,
      opencodeTaskTool,
      generateImageTool,
      sendEmailTool,
      sendTelegramTool,
      fetchNewsTool,
      this.createToolDefinition,
    ]) {
      this.tools.set(tool.definition.name, tool)
    }
  }

  private loadPersisted() {
    const dir = this.toolsDir
    if (!fs.existsSync(dir)) return
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const def: ToolDefinition = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'))
        if (this.tools.has(def.name)) continue
        this.tools.set(def.name, {
          definition: def,
          execute: (args) => this.executeDynamic(def, args),
        })
      } catch { /* skip invalid tool */ }
    }
  }

  private async executeDynamic(def: ToolDefinition, args: Record<string, any>): Promise<string> {
    const raw = def.code || ''
    const escaped = JSON.stringify(args)
    const useSandbox = isSandboxAvailable()

    if (def.language === 'python') {
      const script = raw.includes('{{args}}') ? raw.replace('{{args}}', escaped) : `${raw}\n\nimport json, sys\n_args = json.loads('${escaped.replace(/'/g, "\\'")}')\nprint(main(_args) if 'main' in dir() else _args)`
      const tmp = path.join(this.toolsDir, `_run_${Date.now()}.py`)
      try {
        fs.writeFileSync(tmp, `${raw}\n\nimport json\n_args = json.loads("""${escaped.replace(/"/g, '\\"')}""")\nprint(main(_args))`)
        const cmd = useSandbox ? wrapCommand(`python3 /tmp/_run_${path.basename(tmp)}`, this.toolsDir) : `python3 "${tmp}"`
      return (execSync(cmd, EXEC_OPTS) as string).trim()
    } finally {
      try { fs.unlinkSync(tmp) } catch {}
    }
  }

  if (def.language === 'bash') {
    const script = raw.replace(/\{\{args\}\}/g, escaped)
    const cmd = useSandbox ? wrapCommand(script) : script
    return (execSync(cmd, EXEC_OPTS) as string).trim()
    }

    const jsScript = useSandbox
      ? wrapCommand(`node -e "${raw.replace(/"/g, '\\"').replace(/\n/g, ';')}"`)
      : `node -e "${raw.replace(/"/g, '\\"').replace(/\n/g, ';')}"`
      return (execSync(jsScript, EXEC_OPTS) as string).trim()
  }

  private createToolDefinition: ToolModule = {
    definition: {
      name: 'create_tool',
      description: 'Create and register a new tool that can be used in future conversations. The tool code can use JavaScript, Python, or Bash. The tool receives arguments as a JSON object.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Tool name (snake_case, no spaces)' },
          description: { type: 'string', description: 'What the tool does' },
          language: { type: 'string', description: 'Language: javascript, python, or bash', enum: ['javascript', 'python', 'bash'] },
          code: { type: 'string', description: 'The tool implementation. For python: define a main(args) function that returns a string. For javascript: expression that evaluates to a string. For bash: shell script.' },
          parameters: { type: 'string', description: 'JSON schema for parameters: {"propName":{"type":"string","description":"..."}}' },
          required_params: { type: 'string', description: 'JSON array of required parameter names: ["param1","param2"]' },
        },
        required: ['name', 'description', 'language', 'code'],
      },
    },
    execute: async (args) => {
      const { name, description, language, code, parameters, required_params } = args
      if (this.tools.has(name)) {
        return `Tool "${name}" already exists. Edit it or choose a different name.`
      }

      const def: ToolDefinition = {
        name,
        description,
        language: language as any,
        code: code as string,
        parameters: {
          type: 'object',
          properties: parameters ? JSON.parse(parameters as string) : {},
          required: required_params ? JSON.parse(required_params as string) : [],
        },
      }

      try {
        const result = await this.executeDynamic(def, { test: true })
        console.log(`Tool "${name}" test run result: ${result.slice(0, 200)}`)
      } catch (err: any) {
        return `Tool "${name}" test run FAILED: ${err.message}. Fix the code and try again.`
      }

      fs.writeFileSync(path.join(this.toolsDir, `${name}.json`), JSON.stringify(def, null, 2))

      this.tools.set(name, {
        definition: def,
        execute: (a) => this.executeDynamic(def, a),
      })

      return `Tool "${name}" created and registered successfully! You can now use it by calling the function tool_${name} in your responses.`
    },
  }

  register(name: string, tool: ToolModule): void {
    this.tools.set(name, tool)
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition)
  }

  get(name: string): ToolModule | undefined {
    return this.tools.get(name)
  }

  getSystemPrompt(): string {
    return 'You are localclaw, an autonomous AI agent. Use the available tools to accomplish the user\'s requests.'
  }

  parseToolCall(_text: string): null {
    return null
  }
}
