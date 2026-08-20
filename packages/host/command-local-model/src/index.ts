/**
 * Human-facing `/local-model` command that stops, starts, or reports the local
 * model server serving the local workers. The stop path exists so a user can
 * free the GPU (for gaming); the start path reloads it. Deployment-varying
 * shell commands are Config fields, never constants.
 * @module @deepseek-ai/dsh-command-local-model
 */

import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'command-local-model'

/** Services required before the command can register. */
export const inject = ['commands']

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Shell command that stops the local model server and frees the GPU. */
  stopCommand?: string
  /** Shell command that starts the local model server. */
  startCommand?: string
  /** Shell command that reports whether the server is running. */
  statusCommand?: string
  /** Milliseconds one control command may run before the executor cuts it short. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  stopCommand: z.string().default("Set-Content 'C:/LocalModel/qwen/watchdog.stop' 'stop'; taskkill /IM ninfer-serve.exe /F 2>&1 | Out-Null; if (Test-Path 'C:/LocalModel/qwen/watchdog.pid') { $wd = Get-Content 'C:/LocalModel/qwen/watchdog.pid'; Stop-Process -Id ([int]$wd) -Force -ErrorAction SilentlyContinue }; Write-Output 'local model stopped'"),
  startCommand: z.string().default("Remove-Item 'C:/LocalModel/qwen/watchdog.stop' -ErrorAction SilentlyContinue; Start-Process powershell -ArgumentList @('-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','G:/LocalModel/watchdog-llama.ps1'); Write-Output 'local model watchdog started'"),
  statusCommand: z.string().default("if (Get-Process -Name 'ninfer-serve' -ErrorAction SilentlyContinue) { 'running' } else { 'stopped' }"),
  timeoutMs: z.number().default(120000),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

const USAGE = 'Usage: /local-model <stop|start|status>'

/** The configured command for one action, or undefined for an unknown/missing action. */
function commandFor(action: string, config: ResolvedConfig): string | undefined {
  if (action === 'stop') return config.stopCommand
  if (action === 'start') return config.startCommand
  if (action === 'status') return config.statusCommand
  return undefined
}

/** Run one control command through the optional shell seam and fold it into a CommandResult. */
async function runControl(command: string, timeoutMs: number): Promise<CommandResult> {
  const outcome = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: null, out, err: `failed to spawn powershell: ${String(error)}` }) })
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
  })
  const detail = [outcome.out.trim(), outcome.err.trim()].filter(text => text.length > 0).join('\n')
  if (outcome.code === 0) return { kind: 'success', text: detail.length > 0 ? detail : 'Command exited 0.' }
  const code = outcome.code === null ? 'signal' : String(outcome.code)
  return { kind: 'error', text: `Command exited ${code}${detail.length > 0 ? `:\n${detail}` : ''}` }
}

/** Validate the action and run its command, or report usage. */
function execute(invocation: CommandInvocation, config: ResolvedConfig): Promise<CommandResult> {
  const action = invocation.rawInput.trim().toLowerCase()
  const command = commandFor(action, config)
  if (command === undefined) {
    return Promise.resolve({ kind: 'error', text: `Unknown action "${action}". ${USAGE}` })
  }
  return runControl(command, config.timeoutMs)
}

/** Register the global `/local-model` command. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  ctx.commands.register({
    name: 'local-model',
    description: 'stop, start, or check the local model server (stop frees the GPU)',
    input: { hint: '<stop|start|status>' },
    recordInput: false,
    handler: invocation => execute(invocation, resolved),
  })
}
