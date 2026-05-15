import { execSync } from 'child_process'
import { log } from '../log.js'

const SANDBOX_ENABLED = process.env.LOCALCLAW_SANDBOX_ENABLED === 'true'
const SANDBOX_IMAGE = process.env.LOCALCLAW_SANDBOX_IMAGE || 'ubuntu:22.04'

export function wrapCommand(command: string, cwd?: string): string {
  if (!SANDBOX_ENABLED) return command

  const workDir = cwd || process.cwd()
  log.agent(`Sandbox: wrapping command in Docker (image=${SANDBOX_IMAGE})`)

  const safeCommand = command.replace(/"/g, '\\"')
  return [
    'docker run --rm --network none',
    '--security-opt no-new-privileges --cap-drop ALL',
    `-v "${workDir}:/workspace:ro"`,
    `-w /workspace`,
    SANDBOX_IMAGE,
    `bash -c "${safeCommand}"`,
  ].join(' ')
}

export function isSandboxAvailable(): boolean {
  if (!SANDBOX_ENABLED) return false
  try {
    execSync('docker info 2>/dev/null', { encoding: 'utf-8', timeout: 5000 })
    return true
  } catch {
    log.warn('Sandbox: Docker not available, falling back to direct execution')
    return false
  }
}
