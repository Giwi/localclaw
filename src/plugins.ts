import fs from 'fs'
import path from 'path'
import type { ToolRegistry } from './tools/registry.js'
import { log } from './log.js'

export async function loadPlugins(registry: ToolRegistry, dataDir: string) {
  const pluginDirs = [
    path.join(process.cwd(), 'plugins'),
    path.join(dataDir, 'plugins'),
  ]

  for (const dir of pluginDirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      log.info(`Plugins directory created: ${dir}`)
      continue
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
        const fullPath = path.join(dir, entry.name)
        try {
          const plugin = await import(fullPath)
          const tool = plugin.default || plugin
          if (tool && tool.definition && tool.execute) {
            registry.register(tool.definition.name, tool)
            log.info(`Plugin loaded: ${tool.definition.name} (${entry.name})`)
          } else if (typeof tool === 'function') {
            const result = tool()
            if (result && result.definition && result.execute) {
              registry.register(result.definition.name, result)
              log.info(`Plugin loaded: ${result.definition.name} (${entry.name})`)
            }
          }
        } catch (err: unknown) {
          log.warn(`Failed to load plugin ${entry.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else if (entry.isDirectory()) {
        const pkgJson = path.join(dir, entry.name, 'package.json')
        if (fs.existsSync(pkgJson)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'))
            const mainPath = path.join(dir, entry.name, pkg.main || 'index.js')
            if (fs.existsSync(mainPath)) {
              const plugin = await import(mainPath)
              const tool = plugin.default || plugin
              if (tool && tool.definition && tool.execute) {
                registry.register(tool.definition.name, tool)
                log.info(`Plugin loaded: ${tool.definition.name} (${entry.name})`)
              }
            }
          } catch (err: unknown) {
            log.warn(`Failed to load plugin directory ${entry.name}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
    }
  }

  log.info(`Plugin scan complete: ${pluginDirs.join(', ')}`)
}
