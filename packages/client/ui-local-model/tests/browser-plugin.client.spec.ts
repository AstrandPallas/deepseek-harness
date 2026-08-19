import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { LocalModelControl } from '../src/client/LocalModelControl.tsx'
import { apply, inject, type LocalModelInjected } from '../src/client/index.ts'

const SID = 'local-model-apply' as SessionId

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
}

interface Result {
  ok: boolean
  value: { matched: boolean } | undefined
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declaration = declare(slots)
  ctx.provide('locale', new LocaleRuntime(ctx))

  const executed: string[] = []
  let result: Result = { ok: true, value: { matched: true } }
  const commandsRemote = {
    execute: (_sessionId: SessionId, line: string) => {
      executed.push(line)
      return Promise.resolve(result.ok
        ? { ok: true as const, value: result.value }
        : { ok: false as const, error: { code: 'internal', message: 'boom' } })
    },
  }
  ctx.provide('remote', { commands: commandsRemote })
  ctx.provide('remote.commands', commandsRemote)

  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, declaration, fiber, executed, setResult: (r: Result) => { result = r } }
}

function faceOf(b: Awaited<ReturnType<typeof bench>>): LocalModelInjected {
  const entry = b.slots.entries('conversation.session.header.utilities')[0]
  return (entry?.inject as unknown as () => LocalModelInjected)()
}

describe('ui-local-model browser plugin', () => {
  it('registers the header toggle and toggles stop/start over the command channel', async () => {
    const b = await bench()
    expect(inject).toEqual(['slots', 'remote', 'remote.commands', 'locale'])
    const entry = b.slots.entries('conversation.session.header.utilities')[0]
    expect(entry?.component).toBe(LocalModelControl)
    expect(entry?.options).toMatchObject({ id: 'local-model' })

    const face = faceOf(b)
    expect(face.hooks.localModel.getSnapshot()).toEqual({ running: true })

    await face.toggle(SID)
    expect(b.executed).toEqual(['/local-model stop'])
    expect(face.hooks.localModel.getSnapshot()).toEqual({ running: false })

    await face.toggle(SID)
    expect(b.executed).toEqual(['/local-model stop', '/local-model start'])
    expect(face.hooks.localModel.getSnapshot()).toEqual({ running: true })

    await b.fiber.dispose()
    expect(b.slots.entries('conversation.session.header.utilities')).toHaveLength(0)
  })

  it('surfaces command rejection and unmatched as a failure line', async () => {
    const b = await bench()
    const face = faceOf(b)

    b.setResult({ ok: false, value: undefined })
    await expect(face.toggle(SID)).resolves.toMatch(/boom/)
    b.setResult({ ok: true, value: undefined })
    await expect(face.toggle(SID)).resolves.toMatch(/unknown command/)
  })
})
