import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as commandLocalModel from '@deepseek-ai/dsh-command-local-model'

/** Commands the fake shell was asked to run, in order. */
const runLog: string[] = []

/** A minimal shell provider recording each command and reporting success. */
function fakeShell(): { name: string; apply: (ctx: Context) => void } {
  return {
    name: 'fake-shell',
    apply: (ctx: Context) => {
      ctx.provide('shell', {
        resolve: (request: { command: string; timeoutMs?: number }) => request,
        run: async (spec: { command: string; timeoutMs?: number }) => {
          runLog.push(spec.command)
          return {
            exitCode: 0, signal: null, timedOut: false, aborted: false,
            timeoutMs: spec.timeoutMs ?? 0,
            stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
          }
        },
      })
    },
  }
}

/** Build a live idle agent over a store-owned session, as an app's spine does. */
function stubAgent(ctx: Context, id: string): { agent: Agent; session: Session } {
  const session = ctx.sessions.create(SessionId(id))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session }
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(fakeShell())
  await ctx.plugin(commandLocalModel)
  const { agent } = stubAgent(ctx, `command-local-model-${Math.random()}`)
  ctx.agents.register(agent)
  return { ctx, agent }
}

async function run(test: Harness, suffix: string): Promise<{ kind: string; text?: string }> {
  const settled = await test.ctx.commands.execute(test.agent, `/local-model${suffix}`, [], new AbortController().signal)
  if (settled === undefined) throw new Error('local-model command was not registered')
  return settled.result
}

describe('@deepseek-ai/dsh-command-local-model', () => {
  it('exposes the plugin contract and registers /local-model', async () => {
    const test = await harness()
    expect(commandLocalModel.name).toBe('command-local-model')
    expect(commandLocalModel.inject).toEqual(['commands'])
    expect('default' in commandLocalModel).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandLocalModel)).toBe(commandLocalModel)
    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      name: 'local-model',
      description: 'stop, start, or check the local model server (stop frees the GPU)',
      input: { hint: '<stop|start|status>' },
    })
  })

  it('runs the configured stop command through the shell', async () => {
    runLog.length = 0
    const test = await harness()
    await expect(run(test, ' stop ')).resolves.toEqual({ kind: 'success', text: 'Command exited 0.' })
    expect(runLog).toEqual(["Set-Content 'C:/LocalModel/qwen/watchdog.stop' 'stop'; taskkill /IM ninfer-serve.exe /F 2>&1 | Out-Null; if (Test-Path 'C:/LocalModel/qwen/watchdog.pid') { $wd = Get-Content 'C:/LocalModel/qwen/watchdog.pid'; Stop-Process -Id ([int]$wd) -Force -ErrorAction SilentlyContinue }; Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile','-Command','nvidia-smi -pl 575') | Out-Null; Write-Output 'local model stopped'"])
  })

  it('rejects an unknown action without running anything', async () => {
    runLog.length = 0
    const test = await harness()
    await expect(run(test, ' restart ')).resolves.toEqual({
      kind: 'error',
      text: 'Unknown action "restart". Usage: /local-model <stop|start|status>',
    })
    expect(runLog).toEqual([])
  })
})
